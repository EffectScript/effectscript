// AxiosPromise-like: self-referential interface where methods return the same type
export interface AxiosPromise {
  then(onFulfilled: (response: any) => void): AxiosPromise;
  catch(onRejected: (error: any) => void): AxiosPromise;
}

export declare function makeRequest(): AxiosPromise;

// ReactNode-like: recursive union type (references itself through members)
export type ReactNode = string | number | boolean | null | ReactElement | ReactNode[];

export interface ReactElement {
  type: string;
  props: Record<string, unknown>;
  children: ReactNode;
}

export declare function createElement(type: string): ReactElement;

// Deep recursive chain: A → B → C → A
export interface RequestLike {
  params: ParamsLike;
  query: QueryLike;
  body: any;
}

export interface ParamsLike {
  request: RequestLike;
  values: Record<string, string>;
}

export interface QueryLike {
  request: RequestLike;
  raw: string;
}

export declare function createRequest(): RequestLike;

// Builder pattern: fluent API returning self
export interface QueryBuilder {
  select(fields: string): QueryBuilder;
  where(condition: string): QueryBuilder;
  orderBy(field: string): QueryBuilder;
  execute(): Promise<any>;
}

export declare function createQueryBuilder(): QueryBuilder;
