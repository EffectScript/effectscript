// Fixture: index signature types for type-mapper tests

// 40. String index type
export declare const stringDict: { [key: string]: number };

// 41. Number index type
export declare const numberDict: { [key: number]: string };

// 42. Mixed properties + index
export declare const mixed: { name: string; age: number; [key: string]: any };

// 43. Record<string, T>
export declare const recordType: Record<string, boolean>;

// 44. Intersection with index signature
export declare const intersected: { id: number } & { [key: string]: any };

// 45. Optional properties with index signature
export declare const withOptional: { required: string; optional?: number; [key: string]: any };

// 46. Both string and number index types (string takes priority)
export interface BothIndexes {
  [key: string]: any;
  [index: number]: string;
}
export declare const bothIndexes: BothIndexes;

// 46b. Both index types on a plain object type (tests mapRecordEager path)
export declare const bothIndexesPlain: { [key: string]: any; [index: number]: string };

// W1. Large type (above lazy threshold of 30) with index signature
export declare const largeWithIndex: {
  a1: string; a2: string; a3: string; a4: string; a5: string;
  a6: string; a7: string; a8: string; a9: string; a10: string;
  a11: string; a12: string; a13: string; a14: string; a15: string;
  a16: string; a17: string; a18: string; a19: string; a20: string;
  a21: string; a22: string; a23: string; a24: string; a25: string;
  a26: string; a27: string; a28: string; a29: string; a30: string;
  a31: string;
  [key: string]: string;
};
