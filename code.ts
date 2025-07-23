// This file contains the main code for a Figma plugin.
// It has access to the *figma document* via the figma global object.
// You can access browser APIs in the ui.html file.

// Interface definitions for better TypeScript support
interface ProcessedVariable {
  name: string;
  cleanName: string; // Name with base/ prefix stripped
  lightValue: string; // OKLCH value for light mode
  darkValue: string;  // OKLCH value for dark mode
}

interface ExportResult {
  variables: ProcessedVariable[];
  collectionName: string;
}

// Enhanced hex to OKLCH conversion functions
function hexToOklch(hex: string): string {
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex.split('').map(char => char + char).join('');
  }
  
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  
  const oklch = rgbToOklch(r, g, b);
  
  const L = Number(oklch.L.toFixed(3));
  const C = Number(oklch.C.toFixed(3));
  const H = Number(oklch.H.toFixed(1));
  
  if (C < 0.004) {
    return `oklch(${L} 0 0)`;
  }
  
  return `oklch(${L} ${C} ${H})`;
}

function rgbToOklch(r: number, g: number, b: number): { L: number; C: number; H: number } {
  const linearR = gammaToLinear(r);
  const linearG = gammaToLinear(g);
  const linearB = gammaToLinear(b);
  
  const x = 0.4124564 * linearR + 0.3575761 * linearG + 0.1804375 * linearB;
  const y = 0.2126729 * linearR + 0.7151522 * linearG + 0.0721750 * linearB;
  const z = 0.0193339 * linearR + 0.1191920 * linearG + 0.9503041 * linearB;
  
  const { L: okL, a: okA, b: okB } = xyzToOklab(x, y, z);
  
  const C = Math.sqrt(okA * okA + okB * okB);
  let H = Math.atan2(okB, okA) * (180 / Math.PI);
  
  if (H < 0) H += 360;
  
  return { L: okL, C, H };
}

function gammaToLinear(value: number): number {
  return value <= 0.04045 
    ? value / 12.92 
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

function xyzToOklab(x: number, y: number, z: number): { L: number; a: number; b: number } {
  const l = 0.8189330101 * x + 0.3618667424 * y - 0.1288597137 * z;
  const m = 0.0329845436 * x + 0.9293118715 * y + 0.0361456387 * z;
  const s = 0.0482003018 * x + 0.2643662691 * y + 0.6338517070 * z;
  
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  
  const L = 0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot;
  const a = 1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot;
  const b = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot;
  
  return { L, a, b };
}

function figmaRgbToHex(rgb: { r: number; g: number; b: number }): string {
  const toHex = (n: number) => {
    const hex = Math.round(n * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

// Recursively resolve variable aliases to get the final color value across all collections
async function resolveVariableValue(variable: any, modeId: string, visited = new Set()): Promise<string | null> {
  // Prevent infinite loops
  if (visited.has(variable.id)) {
    console.warn(`Circular reference detected for variable: ${variable.name}`);
    return null;
  }
  visited.add(variable.id);

  console.log(`Resolving variable: ${variable.name}, mode: ${modeId}`);

  const value = variable.valuesByMode[modeId];
  
  if (!value) {
    console.warn(`No value found for variable: ${variable.name}, mode: ${modeId}`);
    return null;
  }

  // If it's a direct color value (RGB object)
  if (typeof value === 'object' && 'r' in value && 'g' in value && 'b' in value) {
    const hex = figmaRgbToHex(value as { r: number, g: number, b: number });
    const oklch = hexToOklch(hex);
    console.log(`Resolved ${variable.name} to final color: ${hex} → ${oklch}`);
    return oklch;
  }

  // If it's a string (hex value)
  if (typeof value === 'string') {
    // Validate hex format
    if (/^#[0-9A-Fa-f]{3,6}$/.test(value)) {
      const oklch = hexToOklch(value);
      console.log(`Resolved ${variable.name} to final hex: ${value} → ${oklch}`);
      return oklch;
    }
  }

  // If it's a variable alias, resolve it across all collections
  if (typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
    console.log(`${variable.name} is an alias to variable ID: ${value.id}`);
    
    const aliasedVariable = await figma.variables.getVariableByIdAsync(value.id);
    if (!aliasedVariable) {
      console.warn(`Could not find aliased variable with ID: ${value.id} for ${variable.name}`);
      return null;
    }

    console.log(`Found aliased variable: ${aliasedVariable.name} in collection: ${aliasedVariable.variableCollectionId}`);

    // Get the collection of the aliased variable to determine the correct mode
    const aliasedCollection = await figma.variables.getVariableCollectionByIdAsync(aliasedVariable.variableCollectionId);
    if (!aliasedCollection) {
      console.warn(`Could not find collection for aliased variable: ${aliasedVariable.name}`);
      return null;
    }

    // Determine the correct mode to use for the aliased variable
    let targetModeId = modeId;

    // If the aliased collection has Light/Dark modes, use the appropriate one
    const lightMode = aliasedCollection.modes.find((m: any) => m.name.toLowerCase() === 'light');
    const darkMode = aliasedCollection.modes.find((m: any) => m.name.toLowerCase() === 'dark');
    
    if (lightMode && darkMode) {
      // This collection has Light/Dark modes, use the same mode name
      const currentModeCollection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
      const currentMode = currentModeCollection?.modes.find((m: any) => m.modeId === modeId);
      
      if (currentMode?.name.toLowerCase() === 'light') {
        targetModeId = lightMode.modeId;
      } else if (currentMode?.name.toLowerCase() === 'dark') {
        targetModeId = darkMode.modeId;
      }
    } else if (aliasedCollection.modes.length === 1) {
      // Single mode collection (like Theme collection), use that mode
      targetModeId = aliasedCollection.modes[0].modeId;
      console.log(`Using single mode: ${aliasedCollection.modes[0].name} for collection: ${aliasedCollection.name}`);
    }

    return await resolveVariableValue(aliasedVariable, targetModeId, visited);
  }

  console.warn(`Could not resolve value for variable: ${variable.name}, mode: ${modeId}, value type: ${typeof value}`);
  return null;
}

// Find the collection that contains "mode" in its name (case insensitive)
async function findModeCollection(): Promise<any | null> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  
  const modeCollections = collections.filter(collection => 
    collection.name.toLowerCase().includes('mode')
  );

  if (modeCollections.length === 0) {
    throw new Error('No collection found with "Mode" in the name. Please create a collection containing "Mode" in its name.');
  }

  if (modeCollections.length > 1) {
    console.warn(`Found ${modeCollections.length} collections with "Mode" in the name. Using the first one: ${modeCollections[0].name}`);
  }

  return modeCollections[0];
}

// Process variables from the mode collection
async function processSemanticVariables(): Promise<ExportResult> {
  console.log('Looking for Mode collection...');
  
  const modeCollection = await findModeCollection();
  console.log(`Found collection: ${modeCollection.name}`);

  // Find Light and Dark modes
  const lightMode = modeCollection.modes.find((m: any) => 
    m.name.toLowerCase() === 'light'
  );
  const darkMode = modeCollection.modes.find((m: any) => 
    m.name.toLowerCase() === 'dark'
  );

  if (!lightMode || !darkMode) {
    throw new Error(`Collection "${modeCollection.name}" must have both "Light" and "Dark" modes. Found modes: ${modeCollection.modes.map((m: any) => m.name).join(', ')}`);
  }

  console.log(`Found Light mode: ${lightMode.name}, Dark mode: ${darkMode.name}`);

  // Get all variables in the mode collection, filtered to COLOR type only
  const allVariables = await figma.variables.getLocalVariablesAsync('COLOR');
  const collectionVariables = allVariables.filter(v => v.variableCollectionId === modeCollection.id);

  // Filter to only base/ variables
  const baseVariables = collectionVariables.filter(v => v.name.startsWith('base/'));

  console.log(`Found ${collectionVariables.length} color variables in collection, ${baseVariables.length} base/ variables`);

  const processedVariables: ProcessedVariable[] = [];

  for (const variable of baseVariables) {
    console.log(`Processing variable: ${variable.name}`);
    
    // Resolve values for both modes
    const lightValue = await resolveVariableValue(variable, lightMode.modeId);
    const darkValue = await resolveVariableValue(variable, darkMode.modeId);

    // Skip variables that don't have both light and dark values
    if (!lightValue || !darkValue) {
      console.warn(`Skipping ${variable.name}: missing light (${!!lightValue}) or dark (${!!darkValue}) value`);
      continue;
    }

    // Clean the variable name (remove base/ prefix)
    let cleanName = variable.name.substring(5); // Remove "base/"

    // Convert any remaining slashes to hyphens for CSS compatibility
    cleanName = cleanName.replace(/\//g, '-');

    console.log(`Successfully processed ${variable.name} → --${cleanName}`);

    processedVariables.push({
      name: variable.name,
      cleanName: cleanName,
      lightValue: lightValue,
      darkValue: darkValue
    });
  }

  if (processedVariables.length === 0) {
    throw new Error('No valid base/ color variables found. Make sure your base/ variables have both Light and Dark mode values and properly resolve to color values.');
  }

  console.log(`Successfully processed ${processedVariables.length} base/ variables`);

  return {
    variables: processedVariables,
    collectionName: modeCollection.name
  };
}

// Generate shadcn-compatible CSS
function generateShadcnCSS(result: ExportResult): string {
  const { variables } = result;

  let css = `@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
`;

  // Generate @theme mappings for all variables
  variables.forEach(variable => {
    css += `  --color-${variable.cleanName}: var(--${variable.cleanName});\n`;
  });

  css += `}

:root {
  --radius: 0.625rem;
`;

  // Add light mode variables
  variables.forEach(variable => {
    css += `  --${variable.cleanName}: ${variable.lightValue};\n`;
  });

  css += `}

.dark {
`;

  // Add dark mode variables  
  variables.forEach(variable => {
    css += `  --${variable.cleanName}: ${variable.darkValue};\n`;
  });

  css += `}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}`;

  return css;
}

// Main plugin execution
async function main() {
  try {
    console.log('Starting semantic variables export...');
    
    const result = await processSemanticVariables();
    
    const css = generateShadcnCSS(result);
    
    figma.ui.postMessage({
      type: 'export-complete',
      css: css,
      variableCount: result.variables.length,
      collectionName: result.collectionName
    });
    
    console.log('Export complete!');
    
  } catch (error) {
    console.error('Error during export:', error);
    figma.ui.postMessage({
      type: 'error',
      message: (error as Error).message || 'Unknown error occurred'
    });
  }
}

// This shows the HTML page in "ui.html".
figma.showUI(__html__, { themeColors: true, width: 400, height: 600 });

// Calls to "parent.postMessage" from within the HTML page will trigger this
// callback. The callback will be passed the "pluginMessage" property of the
// posted message.
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'start-export') {
    await main();
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};