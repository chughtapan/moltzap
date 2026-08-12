/** Describes core app. */
export interface CoreApp {
  readonly port: number;
  close: () => PromiseLike<undefined>;
}
