// Secret files never reach the browser.
//
// The file tree, the file picker, the folder browser, the file viewer and the
// diff view all ask this before listing or returning a file. It is a guard
// against showing a secret by accident (a click in the tree, a path in the
// chat), not a security boundary: whoever is logged in to Cockpit also has the
// terminal and Claude.

/** Directories whose whole contents are secret, wherever they sit. */
const SECRET_DIRECTORIES = new Set([".ssh", ".gnupg", ".aws", ".kube"]);

/** Files that hold credentials by convention. */
const SECRET_NAMES = new Set([
  ".envrc",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".htpasswd",
  "htpasswd",
  "shadow",
  "gshadow",
]);

/** Key, certificate, keystore and token files. */
const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk", ".kdbx", ".token"]);

/** `.env.example` and friends document the variables and hold no values. */
const ENV_TEMPLATE_SUFFIXES = new Set(["example", "sample", "template", "dist", "defaults"]);

const SSH_PRIVATE_KEY = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/;
const CREDENTIALS_FILE = /^\.?(secrets?|credentials?|passwords?)(\.(json|ya?ml|toml|ini|conf|cfg|txt))?$/;
const OAUTH_CLIENT_SECRET = /^client_secret.*\.json$/;

function isEnvFile(name: string): boolean {
  if (name === ".env") return true;
  if (name.startsWith(".env.")) {
    const suffix = name.split(".").pop() ?? "";
    return !ENV_TEMPLATE_SUFFIXES.has(suffix);
  }
  // prod.env, bot.env
  return name.endsWith(".env") && name.length > ".env".length;
}

function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (isEnvFile(lower)) return true;
  if (SECRET_NAMES.has(lower)) return true;
  if (SSH_PRIVATE_KEY.test(lower) || CREDENTIALS_FILE.test(lower) || OAUTH_CLIENT_SECRET.test(lower)) return true;
  const dot = lower.lastIndexOf(".");
  return dot > 0 && SECRET_EXTENSIONS.has(lower.slice(dot));
}

/**
 * Whether a file or directory path, absolute or relative, names something
 * secret: a secret file name, or anything inside (or being) a secret directory.
 */
export function isSecretPath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((segment) => SECRET_DIRECTORIES.has(segment.toLowerCase()))) return true;
  return isSecretName(segments[segments.length - 1]);
}

/** The JSON a route answers instead of a secret file. */
export const SECRET_FILE_ERROR = "Hidden: this looks like a secrets file";
