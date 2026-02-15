import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // We use empty interfaces for extensibility
      "@typescript-eslint/no-empty-object-type": "off",
      // Allow non-null assertions where we know the value exists
      "@typescript-eslint/no-non-null-assertion": "warn",
      // Allow any in hook signatures (opencode plugin API uses any)
      "@typescript-eslint/no-explicit-any": "warn",
      // Require consistent type imports
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "*.config.*"],
  }
);
