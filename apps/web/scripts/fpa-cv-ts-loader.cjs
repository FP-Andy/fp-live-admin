const ts = require('../node_modules/typescript');
module.exports = function (source) {
  return ts.transpileModule(source, { fileName: this.resourcePath, compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
    esModuleInterop: true,
  } }).outputText;
};
