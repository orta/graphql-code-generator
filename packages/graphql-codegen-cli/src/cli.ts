import * as commander from 'commander';
import { introspectionFromFile } from './loaders/introspection-from-file';
import { introspectionFromUrl } from './loaders/introspection-from-url';
import { schemaFromExport } from './loaders/schema-from-export';
import { documentsFromGlobs } from './utils/documents-glob';
import {
  compileTemplate,
  FileOutput,
  ALLOWED_CUSTOM_TEMPLATE_EXT,
} from 'graphql-codegen-compiler';
import {
  debugLog,
  introspectionToGraphQLSchema,
  schemaToTemplateContext,
  transformDocument
} from 'graphql-codegen-core';
import { loadDocumentsSources } from './loaders/document-loader';
import * as path from 'path';
import * as fs from 'fs';
import { scanForTemplatesInPath } from './loaders/templates-scanner';
import {
  EInputType,
  GeneratorConfig,
  getGeneratorConfig
} from 'graphql-codegen-generators';
import * as mkdirp from 'mkdirp';

export interface CLIOptions {
  file?: string;
  url?: string;
  'export'?: string;
  args?: string[];
  template?: string;
  project?: string;
  out?: string;
  header?: string[];
  schema?: any;
  documents?: any;
  projectConfig?: string;
}

interface ProjectConfig {
  flattenTypes: boolean;
  primitives: {
    String: string;
    Int: string;
    Float: string;
    Boolean: string;
    ID: string;
  };
  customHelpers: { [helperName: string]: string };
}

function collect(val, memo) {
  memo.push(val);

  return memo;
}

export const initCLI = (args): any => {
  commander
    .usage('gql-gen [options]')
    .option('-f, --file <filePath>', 'Parse local GraphQL introspection JSON file')
    .option('-u, --url <graphql-endpoint>', 'Parse remote GraphQL endpoint as introspection file')
    .option('-u, --export <export-file>', 'Path to a JavaScript (es5/6) file that exports (as default export) your `GraphQLSchema` object')
    .option('-h, --header [header]', 'Header to add to the introspection HTTP request when using --url', collect, [])
    .option('-t, --template <template-name>', 'Language/platform name templates')
    .option('-p, --project <project-path>', 'Project path(s) to scan for custom template files')
    .option('--project-config <json-file>', 'Project configuration file')
    .option('-m, --no-schema', 'Generates only client side documents, without server side schema types')
    .option('-c, --no-documents', 'Generates only server side schema types, without client side documents')
    .option('-o, --out <path>', 'Output file(s) path', String, './')
    .arguments('<options> [documents...]')
    .parse(args);

  return commander;
};

export const cliError = (err: string) => {
  if (typeof err === 'object') {
    console.log(err);
  }

  console.error('Error: ' + err);
  process.exit(1);

  return;
};

export const validateCliOptions = (options: CLIOptions) => {
  const file = options.file;
  const url = options.url;
  const fsExport = options.export;
  const template = options.template;
  const project = options.project;

  if (!file && !url && !fsExport) {
    cliError('Please specify one of --file, --url or --export flags!');
  }

  if (!template && !project) {
    cliError('Please specify language/platform, using --template flag, or specify --project to generate with custom project!');
  }
};

export const executeWithOptions = async (options: CLIOptions): Promise<FileOutput[]> => {
  validateCliOptions(options);

  const file: string = options.file;
  const url: string = options.url;
  const fsExport: string = options.export;
  const documents: string[] = options.args || [];
  const template: string = options.template;
  const project: string = options.project;
  const projectConfig: string = options.projectConfig || './gql-gen.json';
  const out: string = options.out || './';
  const headers: string[] = options.header;
  const generateSchema: boolean = options.schema;
  const generateDocuments: boolean = options.documents;
  let schemaExportPromise;

  if (file) {
    schemaExportPromise = introspectionFromFile(file).then(introspectionToGraphQLSchema);
  }
  else if (url) {
    schemaExportPromise = introspectionFromUrl(url, headers).then(introspectionToGraphQLSchema);
  }
  else if (fsExport) {
    schemaExportPromise = schemaFromExport(fsExport);
  }

  const graphQlSchema = await schemaExportPromise;

  if (process.env.VERBOSE !== undefined) {
    console.log(`GraphQL Schema is: `, graphQlSchema);
  }

  const context = schemaToTemplateContext(graphQlSchema);
  debugLog(`[executeWithOptions] Schema template context build, the result is: `);
  Object.keys(context).forEach(key => {
    if (Array.isArray(context[key])) {
      debugLog(`Total of ${key}: ${context[key].length}`);
    }
  });

  const transformedDocuments = transformDocument(graphQlSchema, loadDocumentsSources(await documentsFromGlobs(documents)));
  let templateConfig: GeneratorConfig = null;

  if (template && template !== '') {
    debugLog(`[executeWithOptions] using template: ${template}`);
    templateConfig = getGeneratorConfig(template);

    if (!templateConfig) {
      throw new Error(`Unknown template: ${template}!`);
    }
  }

  if (project && project !== '') {
    debugLog(`[executeWithOptions] using project: ${project}`);

    const configPath = path.resolve(process.cwd(), projectConfig);

    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath).toString()) as ProjectConfig;
      debugLog(`[executeWithOptions] Got project config JSON: `, config);
      const templates = scanForTemplatesInPath(project, ALLOWED_CUSTOM_TEMPLATE_EXT);
      const resolvedHelpers: {[key: string]: Function} = {};

      Object.keys(config.customHelpers || {}).map(helperName => {
        const filePath = config.customHelpers[helperName];
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

        if (fs.existsSync(resolvedPath)) {
          const requiredFile = require(resolvedPath);

          if (requiredFile && requiredFile && typeof requiredFile === 'function') {
            resolvedHelpers[helperName] = requiredFile;
          } else {
            throw new Error(`Custom template file ${resolvedPath} does not have a default export function!`);
          }
        } else {
          throw new Error(`Custom template file ${helperName} does not exists in path: ${resolvedPath}`);
        }
      });

      templateConfig = {
        inputType: EInputType.PROJECT,
        templates,
        flattenTypes: config.flattenTypes,
        primitives: config.primitives,
        customHelpers: resolvedHelpers,
      };
    } else {
      throw new Error(`Please specify --projectConfig path or create gql-gen.json in your project root!`);
    }
  }

  return compileTemplate(templateConfig, context, [transformedDocuments], {
    generateSchema,
    generateDocuments,
  }).map((item: FileOutput) => {
    let resultName = item.filename;

    if (!path.isAbsolute(resultName)) {
      const resolved = path.resolve(process.cwd(), out);

      if (fs.existsSync(resolved)) {
        const stats = fs.lstatSync(resolved);

        if (stats.isDirectory()) {
          resultName = path.resolve(resolved, item.filename);
        } else if (stats.isFile()) {
          resultName = resolved;
        }
      } else {
        if (out.endsWith('/')) {
          resultName = path.resolve(resolved, item.filename);
        } else {
          resultName = resolved;
        }
      }
    }

    const resultDir = path.dirname(resultName);
    mkdirp.sync(resultDir);

    return {
      content: item.content,
      filename: resultName,
    };
  });
};
