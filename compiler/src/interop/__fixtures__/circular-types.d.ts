export interface TreeNode {
  value: string;
  children: TreeNode[];
}

export interface NodeA {
  b: NodeB;
}

export interface NodeB {
  a: NodeA;
}

export declare function createTree(value: string): TreeNode;
