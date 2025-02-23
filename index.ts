import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { VerificationKey, Cache, TokenId, PublicKey } from "o1js";
import {
  Mutex,
  CompilationResults,
  CompilationConfig,
  getNetworkKeys,
  compileContracts,
  compilationConfigIsEqual,
  blockchain,
  MinaNetworkInterface,
  TxProvingInput,
  TxProvingOutput,
  proveTransaction,
  TxProvingTracker,
  FailedBeforeSending,
  getContractKeys,
  fetchMinaAccount,
} from "zkusd";
import * as fs from "fs/promises";
import * as path from "path";

type TxProvingRequest = {
  payload: TxProvingInput;
};

type TxProvingResponse = {
  result: TxProvingOutput;
};

// Define the cache path from the environment (or use default)
const CACHE_PATH = process.env.CACHE_PATH || "/mnt/efs/lambda-cache";
const CHAIN = process.env.CHAIN || "devnet";

const countFilePath = path.join(CACHE_PATH, "count.txt");

async function updateCount(): Promise<number> {
  // Ensure the cache directory exists
  await fs.mkdir(CACHE_PATH, { recursive: true });

  let count = 0;
  try {
    const data = await fs.readFile(countFilePath, "utf8");
    count = parseInt(data, 10) || 0;
  } catch (err) {
    console.log("Count file not found, starting at 0");
  }
  count++;
  await fs.writeFile(countFilePath, count.toString(), "utf8");
  return count;
}

function mkExecutionTracker() {
  let resolve: (value: TxProvingOutput) => void;
  let reject: (reason: TxProvingOutput) => void;
  const result = new Promise<TxProvingOutput>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const tracker: TxProvingTracker = {
    proving: {
      resolver: async (serializedTx: string) => {
        const res: TxProvingOutput = {
          success: true,
          serializedProvenTransaction: serializedTx,
        };
        resolve(res);
      },
      rejector: async (error: { status: FailedBeforeSending }) => {
        const res: TxProvingOutput = {
          success: false,
          errors: error.status.errors,
        };
        reject(res);
      },
    },
  };

  return { tracker, result };
}

class ZkUsdLambdaWorker {
  private static _mutex: Mutex = new Mutex();
  private static _compilationResults: CompilationResults;
  private static _compilationConfig: CompilationConfig;
  private static _chain: MinaNetworkInterface;

  private async getNetworkInterface(): Promise<MinaNetworkInterface> {
    if (!ZkUsdLambdaWorker._chain) {
      // we don't acquire mutex if chain has already been initialized
      await ZkUsdLambdaWorker._mutex.runExclusive(async () => {
        if (!ZkUsdLambdaWorker._chain) {
          // check again after waiting for mutex
          ZkUsdLambdaWorker._chain = await MinaNetworkInterface.initChain(
            CHAIN as blockchain
          );
        }
      });
    }
    if (ZkUsdLambdaWorker._chain.network.chainId !== (CHAIN as blockchain)) {
      throw new Error("ZkUsdLambdaWorker: Chain ID mismatch");
    }
    return ZkUsdLambdaWorker._chain;
  }

  private async compileContracts(): Promise<CompilationResults> {
    console.log("⚙️ Starting contract compilation process...");
    console.time("compilation-total");

    const keys = getContractKeys(CHAIN as blockchain);

    const currentConfig = {
      tokenPublicKey: keys.token,
      enginePublicKey: keys.engine,
      cache: Cache.FileSystem(CACHE_PATH),
    };

    if (!ZkUsdLambdaWorker._chain) {
      ZkUsdLambdaWorker._chain = await MinaNetworkInterface.initChain(
        CHAIN as blockchain
      );
    }

    if (!ZkUsdLambdaWorker._compilationResults) {
      await ZkUsdLambdaWorker._mutex.runExclusive(async () => {
        if (!ZkUsdLambdaWorker._compilationResults) {
          ZkUsdLambdaWorker._compilationConfig = {
            tokenPublicKey: keys.token,
            enginePublicKey: keys.engine,
            cache: Cache.FileSystem(CACHE_PATH),
          };
          ZkUsdLambdaWorker._compilationResults = await compileContracts(
            ZkUsdLambdaWorker._compilationConfig
          );
        }
      });
    }

    if (
      !compilationConfigIsEqual(
        ZkUsdLambdaWorker._compilationConfig,
        currentConfig
      )
    ) {
      throw new Error(
        "ZkUsdLambdaWorker: Compilation keys mismatch. Contracts have been compiled for different keys"
      );
    }
    console.timeEnd("compilation-total");

    return ZkUsdLambdaWorker._compilationResults;
  }

  public async prove(payload: TxProvingInput): Promise<TxProvingOutput> {
    console.log("🚀 Starting transaction proof...");
    console.time("proof-total");

    try {
      const compilationResults = await this.compileContracts();
      const chain = await this.getNetworkInterface();
      const context = {
        workerId: "lambda-worker",
        chain,
        args: payload,
        compilationResults,
      };

      //Lets fetch the account
      const account = await fetchMinaAccount({
        publicKey: PublicKey.fromBase58(
          "B62qn6kzsMDdjEncK9vvZAaZo5vW5saMmLFyxUn9n5JY5B5gSqKLtm1"
        ),
        tokenId:
          ZkUsdLambdaWorker._compilationResults.engineInstance.deriveTokenId(),
      });

      console.log("Checking Account", account);

      let { tracker, result } = mkExecutionTracker();

      const provingResult = await ZkUsdLambdaWorker._mutex.runExclusive(
        async () => {
          await proveTransaction(
            context,
            JSON.stringify({
              signedData: payload.transaction.signedZkappCommand.data,
              serializedTx: payload.transaction.serializedTx,
            }),
            tracker
          );
          return await result;
        }
      );

      console.log("✅ Transaction proof completed successfully");
      return provingResult;
    } catch (error) {
      console.error("❌ Error proving transaction:", error);
      throw error;
    } finally {
      console.timeEnd("proof-total");
    }
  }
}

const worker = new ZkUsdLambdaWorker();

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("📥 Lambda invocation started");
  console.log("Event:", JSON.stringify(event, null, 2));
  console.time("lambda-total");

  try {
    console.log("🔄 Getting compilation results...");

    if (!event.body) {
      throw new Error("No body provided");
    }

    const parsedBody = JSON.parse(event.body) as TxProvingRequest;

    const { payload } = parsedBody;

    console.log("🔄 Payload:", payload);

    const provingResult = await worker.prove(payload);

    // Simplified response to match HTTP client prover
    const response: TxProvingResponse = { result: provingResult };

    // Update the counter stored in the filestore
    const count = await updateCount();
    console.log(`🔢 Invocation count is now ${count}`);

    console.log("📤 Preparing response...");

    console.log("✅ Lambda execution successful");
    console.timeEnd("lambda-total");
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(response),
    };
  } catch (error: any) {
    console.error("❌ Lambda execution failed:", {
      message: error.message,
      stack: error.stack,
      name: error.name,
      memoryUsage: process.memoryUsage(),
      executionTime: process.uptime(),
    });

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Error proving transaction",
        error: error.message,
        stack: error.stack,
        memoryUsage: process.memoryUsage(),
        executionTime: process.uptime(),
      }),
    };
  }
};
