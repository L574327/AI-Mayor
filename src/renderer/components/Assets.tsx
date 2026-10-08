// import DarkDesign from 'assets/images/design.dark.png'; //704
// import LightDesign from 'assets/images/design.light.png';
// import DarkConstruction from 'assets/images/construction.dark.png'; //744
// import LightConstruction from 'assets/images/construction.light.png';
// import DarkDoor from 'assets/images/door.dark.png'; //935
// import LightDoor from 'assets/images/door.light.png';
// import DarkReading from 'assets/images/reading.dark.png'; //1105
// import LightReading from 'assets/images/reading.light.png'
// import DarkUsage from 'assets/images/usage.dark.png'; //1181
// import LightUsage from 'assets/images/usage.light.png';
// import DarkHint from 'assets/images/hint.dark.png'; //1387
// import LightHint from 'assets/images/hint.light.png';

/**
 * Dynamically loads an image asset from the assets/images directory.
 * 
 * @param name - The base name of the image file (without extension)
 * @param theme - Optional theme variant ('light' or 'dark'). When provided, loads the themed version of the image
 * @returns The required image asset
 * 
 * @example
 * // Load a basic image
 * const image = getImage('logo.png');
 * 
 * @example
 * // Load a themed image
 * const darkImage = getImage('design', 'dark'); // loads design.dark.png
 * const lightImage = getImage('design', 'light'); // loads design.light.png
 */
export function getImage(name: string, theme?: 'light' | 'dark') {
  if (theme) {
    return require(`assets/images/${name}.${theme}.png`);
  }
  return require(`assets/images/${name}`);
}