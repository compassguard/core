#!/bin/bash
# Verification script for Next fullstack front/back split

set -e

echo "==================== Repo Verification ===================="
echo ""

echo "1. Running tests..."
npm run test
echo "✓ Tests OK"
echo ""

echo "2. Running linter..."
npm run lint
echo "✓ Lint OK"
echo ""

echo "3. Building Next app..."
npm run build
echo "✓ Next build OK"
echo ""

echo "==================== Verification Summary ===================="
echo "Next fullstack app verified."
echo "Run locally with: npm run dev"
echo "Deploy root directory to Vercel."
