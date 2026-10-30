/** One normalized path for the web build, runtime and deployment tools. */
export function normalizeBasePath(value = "") {
  const path = value.replace(/\/$/, "");
  if (path && !/^(?:\/[a-zA-Z0-9_-]+)+$/.test(path))
    throw new Error(
      "APP_BASE_PATH must be empty or an absolute path without query, encoding or dot segments",
    );
  return path;
}

export function applicationUrl(origin, basePath = "") {
  const path = normalizeBasePath(basePath);
  return origin.replace(/\/$/, "") + (path ? `${path}/` : "");
}
