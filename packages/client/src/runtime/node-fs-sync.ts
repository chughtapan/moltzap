import * as fs from "node:fs";

export type NodeFsError = NodeJS.ErrnoException;

export const appendFileSync = (path: string, data: string): void => {
  fs.appendFileSync(path, data);
};

export const chmodSync = (path: string, mode: number): void => {
  fs.chmodSync(path, mode);
};

export const makeDirectorySync = (path: string): void => {
  fs.mkdirSync(path, { recursive: true });
};

export const readLinkSync = (path: string): string => fs.readlinkSync(path);

export const symlinkSync = (target: string, path: string): void => {
  fs.symlinkSync(target, path);
};

export const unlinkSync = (path: string): void => {
  fs.unlinkSync(path);
};
