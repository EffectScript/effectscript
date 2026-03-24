// Fixture: export = namespace with nested exports (like React)
declare namespace MyReact {
  function createElement(tag: string): void;
  function useState<T>(initial: T): [T, (v: T) => void];
  interface Props {
    children: string;
  }
}
export = MyReact;
