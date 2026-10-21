import { describe, expect, it } from 'bun:test';
import {
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
  PET_COLUMNS,
  PET_ROWS,
} from './pet-animation';
import { createPetAlphaMask, isOpaquePetPoint } from './pet-hit-test';

describe('pet alpha hit testing', () => {
  it('only hits opaque pixels in the current atlas frame', () => {
    const width = PET_CELL_WIDTH * PET_COLUMNS;
    const height = PET_CELL_HEIGHT * PET_ROWS;
    const data = new Uint8ClampedArray(width * height * 4);
    const column = 2;
    const row = 3;
    const sourceX = column * PET_CELL_WIDTH + 96;
    const sourceY = row * PET_CELL_HEIGHT + 104;
    data[(sourceY * width + sourceX) * 4 + 3] = 255;
    const mask = createPetAlphaMask({ data, width });
    const bounds = { left: 10, top: 20, width: 192, height: 208 };
    const position = `${(column / (PET_COLUMNS - 1)) * 100}% ${(row / (PET_ROWS - 1)) * 100}%`;

    expect(isOpaquePetPoint(mask, position, bounds, 106, 124)).toBe(true);
    expect(isOpaquePetPoint(mask, position, bounds, 20, 30)).toBe(false);
    expect(isOpaquePetPoint(mask, position, bounds, 9, 124)).toBe(false);
  });
});
