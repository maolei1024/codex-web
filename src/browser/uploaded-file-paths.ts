type UploadedFile = {
  fsPath?: unknown;
  path?: unknown;
};

const uploadedFilePaths = new WeakMap<File, string>();

export function rememberUploadedFilePaths(
  files: readonly File[],
  uploadedFiles: readonly UploadedFile[],
): void {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const uploadedFile = uploadedFiles[index];
    const path = getUploadedPath(uploadedFile);

    if (file && path) {
      uploadedFilePaths.set(file, path);
    }
  }
}

export function getUploadedFilePath(file: File): string | null {
  return uploadedFilePaths.get(file) ?? null;
}

function getUploadedPath(
  uploadedFile: UploadedFile | undefined,
): string | null {
  if (!uploadedFile) {
    return null;
  }

  if (
    typeof uploadedFile.fsPath === "string" &&
    uploadedFile.fsPath.length > 0
  ) {
    return uploadedFile.fsPath;
  }

  if (typeof uploadedFile.path === "string" && uploadedFile.path.length > 0) {
    return uploadedFile.path;
  }

  return null;
}
