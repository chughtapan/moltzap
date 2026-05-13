import fs from "node:fs";

export const appendFileSync = (
  path: string,
  data: string,
  encoding: BufferEncoding,
): void => {
  fs.appendFileSync(path, data, encoding);
};

export const makeDirectorySync = (path: string): void => {
  fs.mkdirSync(path, { recursive: true });
};
