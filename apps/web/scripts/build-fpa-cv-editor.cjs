// Build the actual FPC editor for the local Python CV server. No separate editor implementation.
const fs = require('node:fs');
const path = require('node:path');
const web = path.resolve(__dirname, '..');
const output = path.join(web, 'public/fpa-cv');
const compiled = require(path.join(web, 'node_modules/next/dist/compiled/webpack/webpack.js'));
compiled.init();
const webpack = compiled.webpack;
webpack({
  mode: 'production', entry: path.join(web, 'fpa-cv/fpc-editor.tsx'),
  output: { path: output, filename: 'fpc-editor.bundle.js' },
  resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(web, 'node_modules'), 'node_modules'] },
  module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'fpa-cv-ts-loader.cjs') }] },
  plugins: [new webpack.DefinePlugin({ 'process.env.NEXT_PUBLIC_API_BASE': JSON.stringify('/api') })],
  optimization: { minimize: false },
  devtool: false,
}, (error, stats) => {
  if (error || stats.hasErrors()) { console.error(error || stats.toString({ all: false, errors: true })); process.exitCode = 1; return; }
  fs.writeFileSync(path.join(output, 'fpc-editor.bundle.css'),
    ['globals.css', 'console-theme.css', 'console-workspaces.css', 'console-appearance.css'].map(file => fs.readFileSync(path.join(web, 'app', file), 'utf8')).join('\n') + '\n' + fs.readFileSync(path.join(web, 'fpa-cv/fpc-editor.css'), 'utf8'));
  console.log(stats.toString({ all: false, assets: true, timings: true }));
});
