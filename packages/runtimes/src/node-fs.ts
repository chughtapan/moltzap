import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

interface RecursiveCopyOptions {
  readonly recursive: true;
}

interface RecursiveForceRemoveOptions {
  readonly recursive: true;
  readonly force: true;
}

interface RecursiveMakeDirectoryOptions {
  readonly recursive: true;
}

type SymlinkType = "dir" | "file" | "junction";

export const copyFileAsync = (src: string, dest: string) =>
  fsp.copyFile(src, dest);

export const copyFileSync = (src: string, dest: string): void => {
  fs.copyFileSync(src, dest);
};

export const copyAsync = (
  src: string,
  dest: string,
  options: RecursiveCopyOptions,
) => fsp.cp(src, dest, options);

export const copySync = (
  src: string,
  dest: string,
  options: RecursiveCopyOptions & {
    readonly dereference?: boolean;
    readonly filter?: (src: string) => boolean;
  },
): void => {
  fs.cpSync(src, dest, options);
};

export const existsSync = (path: string): boolean => fs.existsSync(path);

export const makeDirectoryAsync = (
  path: string,
  options: RecursiveMakeDirectoryOptions,
) => fsp.mkdir(path, options);

export const makeTempDirectoryAsync = (prefix: string) => fsp.mkdtemp(prefix);

export const makeDirectorySync = (path: string): void => {
  fs.mkdirSync(path, { recursive: true });
};

export const makeTempDirectorySync = (prefix: string): string =>
  fs.mkdtempSync(prefix);

export const readFileAsync = (path: string) => fsp.readFile(path);

export const readFileStringAsync = (path: string, encoding: BufferEncoding) =>
  fsp.readFile(path, encoding);

export const readFileStringSync = (
  path: string,
  encoding: BufferEncoding,
): string => fs.readFileSync(path, encoding);

export const removeAsync = (
  path: string,
  options: RecursiveForceRemoveOptions,
) => fsp.rm(path, options);

export const removeSync = (
  path: string,
  options: RecursiveForceRemoveOptions,
): void => {
  fs.rmSync(path, options);
};

export const renameAsync = (oldPath: string, newPath: string) =>
  fsp.rename(oldPath, newPath);

export const symlinkSync = (
  target: string,
  path: string,
  type: SymlinkType,
): void => {
  fs.symlinkSync(target, path, type);
};

export const unlinkAsync = (path: string) => fsp.unlink(path);

export const writeFileAsync = (path: string, data: string) =>
  fsp.writeFile(path, data);

export const writeFileSync = (path: string, data: string): void => {
  fs.writeFileSync(path, data);
};
