/** Backwards-compatible Zepto-only setup command. */
process.argv[2]="zepto";
await import("./shopping-setup.js");
export {};
