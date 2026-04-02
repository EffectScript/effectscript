export declare function useState<T>(initial: T): [T, (value: T) => void];
export declare function useEffect(effect: () => void, deps?: unknown[]): void;
export declare function createElement(tag: string, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
