// Minimal fixture: export = value (like lodash or express)
declare function myLib(): void;
declare namespace myLib {
  function helper(x: string): number;
  const VERSION: string;
  interface Config {
    debug: boolean;
  }
}
export = myLib;
