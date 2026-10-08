module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleDirectories: ["node_modules", "src", "test"],
  moduleNameMapper: {
    "^electron$": "<rootDir>/test/mocks/electron.js",
    "^@/(.*)$": "<rootDir>/src/$1",
    "\\.(css|less|sass|scss)$": "identity-obj-proxy",
  },
  transform: {
    "^.+\\.[tj]sx?$": ["ts-jest", { diagnostics: false }],
  },
  modulePathIgnorePatterns: ["<rootDir>/output/"],
};
