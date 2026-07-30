const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Fail fast with a clear, named message instead of a cryptic ethers ABI-encode
// error deep in execution when a required constructor address is blank/missing.
export function makeRequireAddress(moduleName: string) {
    return function requireAddress(label: string, value: string): void {
        if (!ADDRESS_RE.test(value)) {
            throw new Error(
                `${moduleName}: ${label} must be a valid address but got "${value}". ` +
                    "Set the corresponding env var in your .env before deploying.",
            );
        }
    };
}
