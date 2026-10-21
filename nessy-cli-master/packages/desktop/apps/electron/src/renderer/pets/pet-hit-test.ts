import {
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
  PET_COLUMNS,
  PET_ROWS,
} from './pet-animation';

// [nessy-fork] desktop-pet-alpha-hit-test
export interface PetAlphaMask {
  alpha: Uint8ClampedArray;
  width: number;
}

interface RgbaImageData {
  data: Uint8ClampedArray;
  width: number;
}

interface PetBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function createPetAlphaMask(image: RgbaImageData): PetAlphaMask {
  const alpha = new Uint8ClampedArray(image.data.length / 4);
  for (let source = 3, target = 0; source < image.data.length; source += 4) {
    alpha[target] = image.data[source];
    target += 1;
  }
  return { alpha, width: image.width };
}

export function isOpaquePetPoint(
  mask: PetAlphaMask,
  backgroundPosition: string,
  bounds: PetBounds,
  clientX: number,
  clientY: number,
): boolean {
  const localX = clientX - bounds.left;
  const localY = clientY - bounds.top;
  if (
    localX < 0 ||
    localY < 0 ||
    localX >= bounds.width ||
    localY >= bounds.height
  ) {
    return false;
  }

  const [xPercent = 0, yPercent = 0] = backgroundPosition
    .split(' ')
    .map((value) => Number.parseFloat(value));
  const column = Math.round((xPercent / 100) * (PET_COLUMNS - 1));
  const row = Math.round((yPercent / 100) * (PET_ROWS - 1));
  const x = Math.floor((localX / bounds.width) * PET_CELL_WIDTH);
  const y = Math.floor((localY / bounds.height) * PET_CELL_HEIGHT);
  const sourceX = column * PET_CELL_WIDTH + x;
  const sourceY = row * PET_CELL_HEIGHT + y;

  return mask.alpha[sourceY * mask.width + sourceX] > 0;
}
