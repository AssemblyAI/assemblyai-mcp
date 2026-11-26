import { resolveHttpsUrl } from "./config";

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function rejects(name: string, envName: string, value: string | undefined, def: string) {
  if (value === undefined) delete process.env[envName];
  else process.env[envName] = value;
  try {
    const got = resolveHttpsUrl(envName, def, { allowHttpLocalhost: true });
    assert(name, false, `accepted ${got}`);
  } catch (err) {
    assert(name, err instanceof Error && /BAD_ENV/.test(err.message), String(err));
  } finally {
    delete process.env[envName];
  }
}

function accepts(name: string, envName: string, value: string | undefined, def: string, expected: string) {
  if (value === undefined) delete process.env[envName];
  else process.env[envName] = value;
  try {
    assert(name, resolveHttpsUrl(envName, def, { allowHttpLocalhost: true }) === expected);
  } catch (err) {
    assert(name, false, String(err));
  } finally {
    delete process.env[envName];
  }
}

console.log("config base urls");

accepts("1. the default is used when the env var is unset", "TEST_BASE_URL", undefined, "https://api.assemblyai.com", "https://api.assemblyai.com");
accepts("2. a trailing slash is trimmed", "TEST_BASE_URL", "https://api.assemblyai.com///", "https://api.assemblyai.com", "https://api.assemblyai.com");
rejects("3. http to a public host is rejected", "TEST_BASE_URL", "http://api.assemblyai.com", "https://api.assemblyai.com");
rejects("4. http to a private host is rejected", "TEST_BASE_URL", "http://169.254.169.254/latest", "https://api.assemblyai.com");
rejects("5. userinfo is rejected", "TEST_BASE_URL", "https://evil.com@api.assemblyai.com", "https://api.assemblyai.com");
rejects("5b. userinfo with password is rejected", "TEST_BASE_URL", "https://user:pass@api.assemblyai.com", "https://api.assemblyai.com");
rejects("6. an empty value is rejected", "TEST_BASE_URL", "   ", "https://api.assemblyai.com");
rejects("7. a non-url value is rejected", "TEST_BASE_URL", "not-a-url", "https://api.assemblyai.com");
rejects("8. a non-http scheme is rejected", "TEST_BASE_URL", "ftp://api.assemblyai.com", "https://api.assemblyai.com");
accepts("9. http localhost is allowed for local dev", "TEST_BASE_URL", "http://localhost:3000/", "https://api.assemblyai.com", "http://localhost:3000");
accepts("9b. http 127.0.0.1 is allowed for local dev", "TEST_BASE_URL", "http://127.0.0.1:8080", "https://api.assemblyai.com", "http://127.0.0.1:8080");
accepts("9c. http [::1] is allowed for local dev", "TEST_BASE_URL", "http://[::1]:8080/", "https://api.assemblyai.com", "http://[::1]:8080");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
