import { GeneratorOptions } from '@prisma/generator-helper';
import * as path from 'path';
import * as child_process from 'child_process';
import fs from 'fs';
import os from 'os';
import * as dotenv from 'dotenv';
import { PrismaERDConfig } from 'types/generator';
import {
    DML,
    DMLRendererOptions,
    DMLEnum,
    DMLModel,
    DMLField,
} from 'types/dml';
import { SVGRendererMode, SVGRendererOptions } from 'types/svg';

dotenv.config(); // Load the environment variables

function getDataModelFieldWithoutParsing(parsed: string) {
    const startOfField = parsed.indexOf('"datamodel"');
    const openingBracket = parsed.indexOf('{', startOfField);

    let numberOfOpeningBrackets = 0;
    let closingBracket = openingBracket;
    while (closingBracket < parsed.length) {
        const char = parsed[closingBracket++];

        if (char === '{') {
            numberOfOpeningBrackets++;
        } else if (char === '}') {
            numberOfOpeningBrackets--;

            if (numberOfOpeningBrackets === 0) {
                break;
            }
        }
    }

    return parsed.slice(openingBracket, closingBracket);
}

export async function parseDatamodel(
    engine: string,
    model: string,
    tmpDir: string
) {
    // Could theoretically use original file instead of re-writing the option
    // string to new file but logic for finding correct schema.prisma in
    // monorepos and containers can be tricky (see Prisma issue log) so safer
    // to rely on given content
    const tmpSchema = path.resolve(path.join(tmpDir, 'schema.prisma'));

    fs.writeFileSync(tmpSchema, model);

    const parsed: string = await new Promise((resolve, reject) => {
        const process = child_process.exec(
            `"${engine}" --datamodel-path="${tmpSchema}" cli dmmf`
        );
        let output = '';
        process.stderr?.on('data', (l) => {
            if (l.includes('error:')) {
                reject(l.slice(l.indexOf('error:'), l.indexOf('\\n')));
            }
        });
        process.stdout?.on('data', (d) => (output += d));
        process.on('exit', () => {
            resolve(output);
        });
    });

    return getDataModelFieldWithoutParsing(parsed);
}

function renderSVG(dml: DML, options?: SVGRendererOptions) {
    const {
        renderMode = 'links',
        ignoreEnums = false,
    } = options ?? {};

    // Combine Models and Types as they are pretty similar
    const modellikes = dml.models.concat(dml.types);

    for (const model of modellikes) {
        for (const field of model.fields) {
            const isEnum = field.kind === 'enum';
            if (
                isEnum &&
                (renderMode === 'tables' || ignoreEnums)
            ) {
                continue;
            }
        }
    }

    return require('./builder').buildSvg(modellikes);
}

export const mapPrismaToDb = (dmlModels: DMLModel[], dataModel: string) => {
    const splitDataModel = dataModel
        ?.split('\n')
        .filter((line) => line.includes('@map') || line.includes('model '))
        .map((line) => line.trim());

    return dmlModels.map((model) => {
        return {
            ...model,
            fields: model.fields.map((field) => {
                let filterStatus: 'None' | 'Match' | 'End' = 'None';
                // get line with field to \n
                const lineInDataModel = splitDataModel
                    // filter the current model
                    .filter((line) => {
                        if (
                            filterStatus === 'Match' &&
                            line.includes('model ')
                        ) {
                            filterStatus = 'End';
                        }
                        if (
                            filterStatus === 'None' &&
                            line.includes(`model ${model.name} `)
                        ) {
                            filterStatus = 'Match';
                        }
                        return filterStatus === 'Match';
                    })
                    .find(
                        (line) =>
                            line.includes(`${field.name} `) &&
                            line.includes('@map')
                    );
                if (lineInDataModel) {
                    const regex = new RegExp(/@map\(\"(.*?)\"\)/, 'g');
                    const match = regex.exec(lineInDataModel);

                    if (match?.[1]) {
                        const name = match[1]
                            .replace(/^_/, 'z_') // replace leading underscores
                            .replace(/\s/g, ''); // remove spaces

                        field = {
                            ...field,
                            name: name,
                        };
                    }
                }

                return field;
            }),
        };
    });
};

export default async (options: GeneratorOptions) => {
    try {
        const output = options.generator.output?.value || './prisma/ERD.svg';
        const config = options.generator.config as PrismaERDConfig;

        const theme = config.theme || 'forest';
        let mermaidCliNodePath = path.resolve(
            path.join(config.mmdcPath || 'node_modules/.bin', 'mmdc')
        );
        const tableOnly = config.tableOnly === 'true';
        const disableEmoji = config.disableEmoji === 'true';
        const ignoreEnums = config.ignoreEnums === 'true';
        const includeRelationFromFields =
            config.includeRelationFromFields === 'true';
        const disabled = process.env.DISABLE_ERD === 'true';
        const debug =
            config.erdDebug === 'true' || Boolean(process.env.ERD_DEBUG);

        if (debug) {
            console.log('debug mode enabled');
            console.log('config', config);
        }

        if (disabled) {
            return console.log('ERD generator is disabled');
        }
        if (!options.binaryPaths?.queryEngine)
            throw new Error('no query engine found');

        const queryEngine =
            options.binaryPaths?.queryEngine[
                Object.keys(options.binaryPaths?.queryEngine)[0]
            ];

        const tmpDir = fs.mkdtempSync(os.tmpdir() + path.sep + 'prisma-erd-');

        const datamodelString = await parseDatamodel(
            queryEngine,
            options.datamodel,
            tmpDir
        );
        if (!datamodelString) {
            throw new Error('could not parse datamodel');
        }

        if (debug && datamodelString) {
            fs.mkdirSync(path.resolve('prisma/debug'), { recursive: true });
            const dataModelFile = path.resolve('prisma/debug/1-datamodel.json');
            fs.writeFileSync(dataModelFile, datamodelString);
            console.log(`data model written to ${dataModelFile}`);
        }

        let dml: DML = JSON.parse(datamodelString);

        // updating dml to map to db table and column names (@map && @@map)
        dml.models = mapPrismaToDb(dml.models, options.datamodel);

        // default types to empty array
        if (!dml.types) {
            dml.types = [];
        }
        if (debug && dml.models) {
            const mapAppliedFile = path.resolve(
                'prisma/debug/2-datamodel-map-applied.json'
            );
            fs.writeFileSync(mapAppliedFile, JSON.stringify(dml, null, 2));
            console.log(`applied @map to fields written to ${mapAppliedFile}`);
        }

        const svg = renderSVG(dml, {
            ignoreEnums,
        });

        if (debug) {
            const svgFile = path.resolve('prisma/debug/3-svg.svg');
            fs.writeFileSync(svgFile, svg);
            console.log(`svg written to ${svgFile}`);
        }

        fs.writeFileSync(output, svg);

        // default config parameters https://github.com/mermaid-js/mermaid/blob/master/packages/mermaid/src/defaultConfig.ts
        const tempConfigFile = path.resolve(path.join(tmpDir, 'config.json'));
        fs.writeFileSync(
            tempConfigFile,
            JSON.stringify({
                deterministicIds: true,
                maxTextSize: 90000,
            })
        );
    } catch (error) {
        console.error(error);
        throw error;
    }
};
