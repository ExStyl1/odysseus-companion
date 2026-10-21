#!/bin/bash

# Example script showing how to use the whiteboard skill

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Creating a new whiteboard..."
python3 main.py create sample_board

echo ""
echo "Adding a rectangle..."
python3 main.py add-shape rectangle 100 100 --width 200 --height 150 --file sample_board.unidraw

echo ""
echo "Adding a circle..."
python3 main.py add-shape circle 400 300 --width 100 --height 100 --file sample_board.unidraw

echo ""
echo "Adding text..."
python3 main.py add-text "Hello, Whiteboard!" 200 200 --file sample_board.unidraw

echo ""
echo "Adding a line..."
python3 main.py add-line 100 100 400 300 --file sample_board.unidraw

echo ""
echo "Loading the whiteboard to see its contents..."
python3 main.py load sample_board.unidraw

echo ""
echo "Exporting to PNG..."
python3 main.py export png sample_board.png --file sample_board.unidraw

echo ""
echo "Done! Check the generated files."