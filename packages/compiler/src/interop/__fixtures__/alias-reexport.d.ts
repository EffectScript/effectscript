// Fixture: alias re-exports
// This tests that symbols re-exported via aliases are resolved correctly
export declare function directFn(): string;
export { otherFn } from "./alias-reexport-source";

// Namespace re-export (import * as X; export { X })
import * as submod from "./alias-reexport-source";
export { submod };
