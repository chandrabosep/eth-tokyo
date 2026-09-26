/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // wagmi/viem pull in optional peer deps that Next tries to resolve on the server.
    config.externals.push("pino-pretty", "lokijs", "encoding");

    // AppKit's wagmi adapter imports the whole `@wagmi/connectors` barrel, which reaches the Base
    // Account connector, which reaches Coinbase's CDP SDK, which statically imports `@x402/*` —
    // optional peers npm correctly did not install. Webpack still has to resolve the import, and
    // the build dies on it. Aliasing them to `false` hands webpack an empty module instead: the
    // code is bundled but never executed, because nothing here connects a Base Account.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core": false,
      "@x402/evm": false,
      "@x402/svm": false,
      "@x402/extensions": false,
      // Same story one connector over: MetaMask's SDK imports React Native's async storage.
      "@react-native-async-storage/async-storage": false,
    };
    return config;
  },
};

export default nextConfig;
