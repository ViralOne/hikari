/// <reference types="vite/client" />

// TypeScript 7 rejects a side-effect import of a module it has no declaration for (TS2882), where
// 5.9 let it pass. The CSS imports in index.tsx are exactly that, and Vite already ships the
// declarations for them, so this reference is all that was missing.
