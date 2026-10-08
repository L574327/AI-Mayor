module.exports = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  moduleDirectories: ["node_modules", "src", "test"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "\\.(css|scss)$": "identity-obj-proxy",
  },
  transform: {
    "^.+\\.[tj]sx?$": ["ts-jest", { diagnostics: false }],
  },
  modulePathIgnorePatterns: ["<rootDir>/output/"],
};
