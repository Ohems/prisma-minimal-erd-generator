import { digl } from '@crinkles/digl';
import { Edge, Graph } from '@crinkles/digl/dist/types';
import { DMLModel } from 'types/dml';

interface VerticalLine {
    x: number;
    previousElement: HorizontalLine;
    nextElement: HorizontalLine;
}

interface HorizontalLine {
    y: number;
    start: VerticalLine | ConnectionPoint;
    end: VerticalLine | ConnectionPoint;
}

interface ConnectionPoint {
    x: number;
    y: number;
    name: string;
}

interface Connection {
    relationName: string;
    source: string;
    target: string;
    fromLayer: number;
    toLayer: number;
}

interface Element {
    y: number;
    x: number;
    height: number;
    width: number;
    model?: DMLModel;
}

interface Layer {
    width: number;
    elements: Element[];
}

interface Tree {
    y: number;
    height: number;
    width: number;
    connections: Connection[];
    layers: Layer[];
    lineLayers: HorizontalLine[][][];
}

function buildModelSvg(element: Element | HorizontalLine) {
    const MARGIN = 2;
    const LINE_THICKNESS = 1;

    const { x, y, model } = element as Element;

    if (model) {
        let _y = y;

        const connectionPoints: ConnectionPoint[] = [];

        let width = model.name.length * 8 + MARGIN * 2;
        let height = 12 + MARGIN * 2;

        const linkingFields = model.fields.filter((f) => !!f.relationName);

        for (const linkingField of linkingFields) {
            const lfWidth = linkingField.name.length * 8 + MARGIN * 2;
            if (lfWidth > width) {
                width = lfWidth;
            }
            height += 12 + MARGIN;
        }

        const linkingFieldSvgLines = [];

        if (linkingFields.length > 0) {
            _y += 12 + MARGIN;
            linkingFieldSvgLines.push(
                `<line x1="${x + 2}" y1="${_y}" x2="${
                    x + width - 2
                }" y2="${_y}" stroke="black" />`
            );
            _y += 1;
        }

        for (const linkingField of linkingFields) {
            linkingFieldSvgLines.push(
                `<text x="${x + width / 2}" y="${
                    _y + MARGIN
                }" font-family="monospace" font-size="12px" dominant-baseline="hanging" text-anchor="middle">${
                    linkingField.name
                }</text>`
            );

            connectionPoints.push({
                x: x + width,
                y: _y + (12 + MARGIN) / 2,
                name: linkingField.relationName as string,
            });

            _y += 12 + MARGIN;
        }

        return {
            width,
            height,
            connectionPoints,
            svgLines: [
                `<rect x="${x}" y="${y}" width="${width}" height="${height}" style="fill:white;stroke:black" />`,
                `<text x="${x + width / 2}" y="${
                    y + MARGIN
                }" font-family="monospace" font-size="12px" dominant-baseline="hanging" text-anchor="middle">${
                    model.name
                }</text>`,

                ...linkingFieldSvgLines,
            ],
        };
    }

    const { start, end } = element as HorizontalLine;

    return {
        width: 0,
        height: MARGIN * 2 + LINE_THICKNESS,
        svgLines: [
            `<line x1="${start.x}" y1="${y}" x2="${end.x}" y2="${y}" stroke="black" />`,
        ],
    };
}

function buildSvgLines(trees: Tree[]) {
    const svgLines = [];

    for (const tree of trees) {
        for (const layer of tree.layers) {
            for (const element of layer.elements) {
                const modelSvg = buildModelSvg(element);
                svgLines.push(...modelSvg.svgLines);
            }
        }
    }

    return svgLines;
}

function buildConnections(graph: Graph, trees: Tree[]) {
    // Build connections
    for (let treeIdx = 0; treeIdx < trees.length; treeIdx++) {
        for (
            let layerIdx = 0;
            layerIdx < trees[treeIdx].layers.length;
            layerIdx++
        ) {
            for (const element of trees[treeIdx].layers[layerIdx].elements) {
                for (const field of element.model?.fields || []) {
                    for (const source of field.relationFromFields || []) {
                        for (const target of field.relationToFields || []) {
                            const conn = {
                                relationName: field.relationName || '',
                                source,
                                target,
                                fromLayer: layerIdx,
                                toLayer: graph[treeIdx]
                                    .findIndex((a) =>
                                        a.findIndex((b) => b === field.type) >= 0
                                    ),
                            };
                            trees[treeIdx].connections.push(conn);
                        }
                    }
                }
            }
        }
    }
}

function resolveLocations(trees: Tree[]) {
    const MARGIN = 10;
    const GAP = 5;

    let treeY = 0;
    let largestTreeWidth = MARGIN * 2;

    for (const tree of trees) {
        tree.width = 0;
        tree.height = 0;

        let x = MARGIN;
        tree.y = treeY + MARGIN;

        for (const layer of tree.layers) {
            if (x > MARGIN) {
                x += GAP;
            }

            layer.width = 0;
            let elementY = tree.y;

            for (const element of layer.elements) {
                element.x = x;
                element.y = elementY;

                const { width, height } = buildModelSvg(element);
                element.height = height;
                element.width = width;

                if (width > layer.width) {
                    layer.width = width;
                }

                if (height > tree.height) {
                    tree.height = height;
                }

                elementY += element.height + MARGIN;
                if (elementY > tree.height) {
                    tree.height = elementY;
                }
            }

            for (const element of layer.elements) {
                // Center all of the elements within the layer
                element.x += (layer.width - element.width) / 2;
            }

            x += layer.width;
        }

        tree.width = x + MARGIN;
        tree.height += MARGIN * 2;

        treeY += tree.height;

        if (tree.width > largestTreeWidth) {
            largestTreeWidth = tree.width;
        }
    }

    return {
        width: largestTreeWidth,
        height: treeY,
    };
}

export function buildSvg(models: DMLModel[]) {
    const edges: Edge[] = [];

    for (const model of models) {
        for (const field of model.fields) {
            if ((field.relationFromFields || []).length > 0) {
                edges.push({ source: model.name, target: field.type });
            }
        }
    }

    const graph = digl(edges);

    const layers: DMLModel[][][] = graph.map((g) =>
        g.map((t) =>
            t.map((moduleName) => {
                const model = models.find((m) => m.name === moduleName);
                if (!model) {
                    throw new Error(`unable to find module ${moduleName}`);
                }
                return model;
            })
        )
    );

    const trees: Tree[] = layers.map((l) => ({
        y: 0,
        height: 0,
        width: 0,
        connections: [],
        layers: l.map(
            (l) =>
                ({
                    width: 0,
                    elements: l.map(
                        (m) =>
                            ({
                                y: 0,
                                x: 0,
                                height: 0,
                                width: 0,
                                model: m,
                            }) as Element
                    ),
                }) as Layer
        ),
        lineLayers: [[[]]],
    }));

    buildConnections(graph, trees);
    const { width, height } = resolveLocations(trees);
    const svgLines = buildSvgLines(trees);

    return (
        `<svg viewBox="${0} ${0} ${width} ${height}" style="background-color:white" xmlns="http://www.w3.org/2000/svg">\n` +
        `\t${svgLines.join('\n\t')}\n` +
        '</svg>'
    );
}
