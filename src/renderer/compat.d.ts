import type { JSX as ReactJSX } from "react";

declare global {
  namespace JSX {
    type Element = ReactJSX.Element;
  }
}

declare module "*.css" {
  const classes: Record<string, string>;
  export default classes;
}

export {};
