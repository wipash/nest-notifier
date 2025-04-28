# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands
- **Deploy**: `pnpm deploy` - Deploy to Cloudflare Workers
- **Development**: `pnpm dev` - Run local dev server using Wrangler
- **Testing**: `pnpm test` - Run all tests with Vitest
- **Single Test**: `pnpm test -- path/to/test.spec.ts` - Run a specific test file
- **Watch Mode**: `pnpm test -- --watch` - Run tests in watch mode
- **Type Generation**: `pnpm cf-typegen` - Generate Cloudflare types

## Code Style
- **Formatting**: 2-space indentation for TypeScript, 4-space for JavaScript examples
- **Types**: Use strict TypeScript with comprehensive interfaces in `types.ts`
- **Naming**: 
  - `camelCase` for variables and functions
  - `PascalCase` for interfaces and types
- **Error Handling**: Use try/catch blocks with detailed error logging
- **Imports**: Group imports by source (internal/external)
- **Async**: Use async/await pattern for async operations
- **Logging**: Use console.log/error with descriptive prefixes
- **Security**: Implement timing-safe comparisons for secrets and validate all requests