#!/bin/bash

#Remove dist/node_modules/package-lock.json
rm -rf dist
rm -rf node_modules
rm package-lock.json

#npm install
npm install

# Compile TypeScript
echo "Compiling TypeScript..."
npm run build

# Rename index.js to index.mjs
echo "Renaming to .mjs..."
cd dist
mv index.js index.mjs

# Create zip file including node_modules and compiled JS
echo "Creating deployment package..."
cp -r ../node_modules .
zip -r ../lambda_function.zip ./*
cd ..

# Deploy to Lambda using AWS CLI
echo "Deploying to Lambda..."
aws lambda update-function-code \
    --function-name zkusd-prover-lambda \
    --zip-file fileb://lambda_function.zip

# Clean up
echo "Cleaning up..."
rm lambda_function.zip

echo "Deployment complete!"