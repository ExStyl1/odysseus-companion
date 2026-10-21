#!/usr/bin/env python3
"""
Whiteboard CLI tool - полная поддержка связей и генерации диаграмм
Совместимо с whiteboard.t-tech.team форматом
"""

import argparse
import json
import os
import sys
import re
from typing import Dict, List, Any, Optional, Tuple

# Add the lib directory to the Python path
sys.path.append(os.path.join(os.path.dirname(__file__), 'lib'))

try:
    from whiteboard import (
        Whiteboard, Style, Shape, TextElement, Connection,
        ShapeType, LineStyle, LineType, ArrowType,
        generate_id,
    )
except ImportError as e:
    print(f"Error importing whiteboard module: {e}")
    sys.exit(1)


# ============================================================================
# Парсер LikeC4-подобного синтаксиса
# ============================================================================

class DiagramParser:
    """Parser for diagram description language"""

    def __init__(self, wb: Whiteboard):
        self.wb = wb
        self.current_x = 100
        self.current_y = 100
        self.row_height = 120
        self.col_width = 220

    def parse(self, description: str) -> Whiteboard:
        """
        Parse a natural language or structured description.

        Поддерживаемые форматы:
        1. LikeC4-подобный: "user -> frontend : uses"
        2. JSON-подобный: '{"nodes": [...], "edges": [...]}'
        3. Natural language: "создай пользователя и фронтенд, соедини их"
        """
        description = description.strip()

        # Try JSON first
        if description.startswith('{'):
            return self._parse_json(description)

        # Try LikeC4-like syntax
        if '->' in description or '<->' in description:
            return self._parse_likec4(description)

        # Try natural language
        return self._parse_natural(description)

    def _parse_json(self, text: str) -> Whiteboard:
        """Parse JSON format"""
        try:
            data = json.loads(text)
            nodes = data.get('nodes', [])
            edges = data.get('edges', [])

            # Create nodes
            for node in nodes:
                self._create_node_from_dict(node)

            # Create edges
            for edge in edges:
                self._create_edge_from_dict(edge)

            return self.wb
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON: {e}")

    def _parse_likec4(self, text: str) -> Whiteboard:
        """Parse LikeC4-like syntax"""
        lines = text.strip().split('\n')
        elements_created = {}

        for line in lines:
            line = line.strip()
            if not line or line.startswith('//') or line.startswith('#'):
                continue

            # Skip specification/view blocks
            if line.startswith('specification') or line.startswith('view'):
                continue
            if line == '{' or line == '}':
                continue

            # Connection: source -> target : label
            conn_match = re.match(
                r'(\w+)\s*(?:<->|->|-->|-.->|==>)\s*(\w+)\s*(?::\s*(.+))?',
                line
            )
            if conn_match:
                source_id = conn_match.group(1)
                target_id = conn_match.group(2)
                label = conn_match.group(3) or ""

                # Create elements if not exist
                if source_id not in elements_created:
                    self._create_element_auto(source_id)
                    elements_created[source_id] = True
                if target_id not in elements_created:
                    self._create_element_auto(target_id)
                    elements_created[target_id] = True

                # Determine line style
                if '<->' in line:
                    arrow_end = "arrow"
                elif '-->' in line:
                    arrow_end = "arrow"
                elif '-.->' in line:
                    arrow_end = "arrow"
                else:
                    arrow_end = "arrow"

                line_style = "da" if '-.->' in line else "s"

                self.wb.add_connection(
                    source=source_id,
                    target=target_id,
                    label=label.strip(),
                    line_style=line_style,
                    arrow_end=arrow_end,
                )
                continue

            # Element definition: id [label] or id [label] #color
            elem_match = re.match(r'(\w+)\s*\[([^\]]+)\]\s*(?:#(\w+))?', line)
            if elem_match:
                elem_id = elem_match.group(1)
                label = elem_match.group(2).strip()
                color = elem_match.group(3)

                self._create_node(elem_id, label, color)
                elements_created[elem_id] = True
                continue

        return self.wb

    def _parse_natural(self, text: str) -> Whiteboard:
        """Parse natural language description"""
        # Simple heuristic: find entities and relationships
        # This is a basic implementation - can be enhanced with AI

        # Look for patterns like "X connected to Y", "X links Y", etc.
        patterns = [
            (r'(\w+)\s+(?:соединён?н?а?о?м?|connected)\s+(?:с\s+)?(\w+)', 'straight'),
            (r'(\w+)\s+->\s+(\w+)', 'straight'),
            (r'(\w+)\s+links?\s+(\w+)', 'straight'),
            (r'(\w+)\s+calls?\s+(\w+)', 'straight'),
            (r'(\w+)\s+uses?\s+(\w+)', 'straight'),
        ]

        elements_created = {}

        for pattern, line_type in patterns:
            matches = re.findall(pattern, text, re.IGNORECASE)
            for match in matches:
                source, target = match[0], match[1]
                if source not in elements_created:
                    self._create_element_auto(source)
                    elements_created[source] = True
                if target not in elements_created:
                    self._create_element_auto(target)
                    elements_created[target] = True

                self.wb.add_connection(source, target, arrow_end="arrow")

        # If no patterns matched, just create elements from words
        if not elements_created:
            words = re.findall(r'\b[A-Z][a-zA-Z0-9]+\b', text)
            words = [w for w in words if len(w) > 2 and w.lower() not in [
                'the', 'and', 'with', 'from', 'into', 'through', 'between'
            ]]

            for i, word in enumerate(words[:6]):  # Limit to 6 elements
                self._create_element_auto(word)

        return self.wb

    def _create_element_auto(self, elem_id: str) -> Whiteboard:
        """Create an element with automatic positioning"""
        # Calculate position in a grid
        index = len(self.wb.elements)
        col = index % 4
        row = index // 4

        x = self.current_x + col * self.col_width
        y = self.current_y + row * self.row_height

        # Determine type from name
        label = elem_id.replace('_', ' ').replace('-', ' ')

        # Heuristic for element type
        if any(k in elem_id.lower() for k in ['user', 'actor', 'client']):
            return self.wb.create_user(elem_id, label, x, y)
        elif any(k in elem_id.lower() for k in ['db', 'database', 'storage', 'postgres', 'mysql']):
            return self.wb.create_database(elem_id, label, x, y)
        elif any(k in elem_id.lower() for k in ['queue', 'kafka', 'rabbit', 'sqs']):
            return self.wb.create_node(elem_id, label, x, y, shape="5", color_palette="yellow")
        else:
            return self.wb.create_component(elem_id, label, x, y)

    def _create_node(self, elem_id: str, label: str, color: str = None) -> Whiteboard:
        """Create a node with specific ID and label"""
        # Check if element already exists
        if self.wb.get_element(elem_id):
            return self.wb

        index = len(self.wb.elements)
        col = index % 4
        row = index // 4

        x = self.current_x + col * self.col_width
        y = self.current_y + row * self.row_height

        # Heuristic for shape based on label
        shape = "2"  # default rounded
        palette = "blue"

        if '[( ' in label or 'database' in label.lower():
            shape = "8"  # cylinder
            palette = "purple"
        elif '(( ' in label or 'user' in label.lower():
            shape = "3"  # circle
            palette = "green"
        elif '[[ ' in label or 'queue' in label.lower():
            shape = "5"  # diamond
            palette = "yellow"

        return self.wb.create_node(
            id=elem_id,
            label=label.replace('[', '').replace(']', '').replace('( ', '').replace(' )', ''),
            x=x,
            y=y,
            shape=shape,
            color_palette=palette,
        )

    def _create_node_from_dict(self, node: dict):
        """Create node from JSON dict"""
        elem_id = node.get('id', generate_id())
        label = node.get('label', elem_id)
        x = node.get('x', self.current_x)
        y = node.get('y', self.current_y)
        shape = node.get('shape', '2')
        palette = node.get('color', 'blue')

        self.wb.create_node(
            id=elem_id,
            label=label,
            x=x,
            y=y,
            shape=shape,
            color_palette=palette,
        )

    def _create_edge_from_dict(self, edge: dict):
        """Create edge from JSON dict"""
        self.wb.add_connection(
            source=edge.get('source', ''),
            target=edge.get('target', ''),
            label=edge.get('label', ''),
            line_type=edge.get('lineType', 'straight'),
            line_style=edge.get('lineStyle', 's'),
            arrow_end=edge.get('arrowEnd', 'arrow'),
        )


# ============================================================================
# CLI Commands
# ============================================================================

def cmd_create(args):
    """Create a new empty whiteboard"""
    wb = Whiteboard(width=args.width, height=args.height)
    file_path = f"{args.name}.unidraw"
    try:
        wb.save(file_path)
        print(f"Created new whiteboard: {file_path}")
    except Exception as e:
        print(f"Error creating whiteboard: {e}")
        sys.exit(1)


def cmd_add_node(args):
    """Add a node to the whiteboard"""
    try:
        wb = Whiteboard.load(args.file)

        shape_map = {
            'rectangle': '1',
            'rounded': '2',
            'circle': '3',
            'diamond': '5',
            'cylinder': '8',
        }

        wb.create_node(
            id=args.id or generate_id(),
            label=args.label,
            x=args.x,
            y=args.y,
            width=args.width,
            height=args.height,
            shape=shape_map.get(args.shape, '2'),
            color_palette=args.color,
            bold=args.bold,
        )
        wb.save(args.file)
        print(f"Added node '{args.label}' to {args.file}")
    except Exception as e:
        print(f"Error adding node: {e}")
        sys.exit(1)


def cmd_add_text(args):
    """Add text to the whiteboard"""
    try:
        wb = Whiteboard.load(args.file)
        wb.create_text(
            text=args.text,
            x=args.x,
            y=args.y,
            width=args.width,
            height=args.height,
            color=args.color,
            font_size=args.font_size,
            text_align=args.align,
            bold=args.bold,
        )
        wb.save(args.file)
        print(f"Added text to {args.file}")
    except Exception as e:
        print(f"Error adding text: {e}")
        sys.exit(1)


def cmd_connect(args):
    """Add a connection between two elements"""
    try:
        wb = Whiteboard.load(args.file)

        wb.add_connection(
            source=args.source,
            target=args.target,
            label=args.label or "",
            line_type=args.line_type,
            line_style=args.line_style,
            line_width=args.line_width,
            line_color=args.line_color,
            arrow_start=args.arrow_start,
            arrow_end=args.arrow_end,
            source_anchor=args.source_anchor,
            target_anchor=args.target_anchor,
        )
        wb.save(args.file)
        print(f"Added connection {args.source} -> {args.target}")
    except Exception as e:
        print(f"Error adding connection: {e}")
        sys.exit(1)


def cmd_draw(args):
    """
    Draw a diagram from a description.

    Supports:
    - LikeC4-like syntax: "user -> frontend : uses"
    - JSON format: '{"nodes": [...], "edges": [...]}'
    - Natural language: "create user and frontend connected"
    """
    try:
        # Read description from file or argument
        if args.file:
            with open(args.file, 'r', encoding='utf-8') as f:
                description = f.read()
        else:
            description = args.description

        if not description:
            print("Error: No description provided")
            sys.exit(1)

        wb = Whiteboard(width=args.width, height=args.height)
        parser = DiagramParser(wb)
        parser.parse(description)

        # Auto-size canvas
        if args.auto_size:
            wb.auto_size_canvas()

        output_path = args.output or "diagram.unidraw"
        if not output_path.endswith('.unidraw'):
            output_path += '.unidraw'

        wb.save(output_path)
        print(f"Created diagram: {output_path}")
        print(f"  Elements: {len(wb.elements)}")
        print(f"  Connections: {len(wb.connections)}")

    except Exception as e:
        print(f"Error drawing diagram: {e}")
        sys.exit(1)


def cmd_layout(args):
    """Apply layout to elements in the whiteboard"""
    try:
        wb = Whiteboard.load(args.file)

        # Get element IDs
        element_ids = args.elements.split(',')

        if args.layout == 'horizontal':
            wb.layout_horizontal(
                element_ids,
                start_x=args.x,
                start_y=args.y,
                spacing=args.spacing,
            )
        elif args.layout == 'vertical':
            wb.layout_vertical(
                element_ids,
                start_x=args.x,
                start_y=args.y,
                spacing=args.spacing,
            )
        elif args.layout == 'grid':
            wb.layout_grid(
                element_ids,
                start_x=args.x,
                start_y=args.y,
                cols=args.cols,
                spacing_x=args.spacing,
                spacing_y=args.spacing,
            )

        wb.save(args.file)
        print(f"Applied {args.layout} layout to {len(element_ids)} elements")
    except Exception as e:
        print(f"Error applying layout: {e}")
        sys.exit(1)


def cmd_export(args):
    """Export the whiteboard to a specific format"""
    try:
        wb = Whiteboard.load(args.file)

        if args.format == 'json':
            output_file = args.output if args.output.endswith('.json') else f"{args.output}.json"
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(wb.to_dict(), f, indent=2, ensure_ascii=False)
            print(f"Exported to JSON: {output_file}")

        elif args.format == 'png':
            # Use the render script
            render_script = os.path.join(os.path.dirname(__file__), 'render_whiteboard.py')
            if os.path.exists(render_script):
                import subprocess
                result = subprocess.run(
                    ['python3', render_script, args.file, args.output],
                    capture_output=True,
                    text=True
                )
                if result.returncode == 0:
                    print(f"Exported to PNG: {args.output}")
                else:
                    print(f"Error exporting PNG: {result.stderr}")
                    sys.exit(1)
            else:
                print("Error: render_whiteboard.py not found")
                sys.exit(1)

        elif args.format in ['svg', 'pdf']:
            print(f"Export to {args.format} is not yet implemented")
            sys.exit(1)

    except Exception as e:
        print(f"Error exporting whiteboard: {e}")
        sys.exit(1)


def cmd_load(args):
    """Load and display a whiteboard"""
    try:
        wb = Whiteboard.load(args.file)
        print(f"Loaded whiteboard from {args.file}")
        print(f"  Elements: {len(wb.elements)}")
        print(f"  Connections: {len(wb.connections)}")
        print(json.dumps(wb.to_dict(), indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"Error loading whiteboard: {e}")
        sys.exit(1)


def cmd_list(args):
    """List all elements in a whiteboard"""
    try:
        wb = Whiteboard.load(args.file)

        print(f"\n{'ID':<25} {'Type':<12} {'Label/Text':<30} {'Position':<15}")
        print("-" * 85)

        for elem in wb.elements:
            label = elem.text.replace('<p>', '').replace('</p>', '').replace('<b>', '').replace('</b>', '')[:28]
            pos = f"({elem.position['x']:.0f}, {elem.position['y']:.0f})"
            print(f"{elem.id:<25} {elem.type:<12} {label:<30} {pos:<15}")

        if wb.connections:
            print(f"\n{'Connections':<25} {'Source':<15} {'Target':<15} {'Label':<20}")
            print("-" * 85)
            for conn in wb.connections:
                label = conn.label[:18] if conn.label else ""
                print(f"  {conn.id[:23]:<25} {conn.source_id:<15} {conn.target_id:<15} {label:<20}")

    except Exception as e:
        print(f"Error listing elements: {e}")
        sys.exit(1)


# ============================================================================
# Main
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Whiteboard CLI - создание диаграмм и схем',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Примеры:
  Создать пустую whiteboard:
    python3 main.py create my_diagram

  Нарисовать диаграмму из описания (LikeC4-синтаксис):
    python3 main.py draw "user -> frontend : uses
                          frontend -> backend : API
                          backend -> database : CRUD"

  Нарисовать из JSON файла:
    python3 main.py draw --file diagram.json --output arch.unidraw

  Добавить узел:
    python3 main.py add-node "Frontend" 100 100 --id frontend --shape rounded

  Добавить связь:
    python3 main.py connect frontend backend --label "API call" --arrow-end arrow

  Применить раскладку:
    python3 main.py layout horizontal --elements "user,frontend,backend" --file diagram.unidraw

  Экспорт в PNG:
    python3 main.py export png output.png --file diagram.unidraw
        """
    )

    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    # Create command
    create_parser = subparsers.add_parser('create', help='Создать новую пустую whiteboard')
    create_parser.add_argument('name', help='Имя файла (без расширения)')
    create_parser.add_argument('--width', type=int, default=2000, help='Ширина холста')
    create_parser.add_argument('--height', type=int, default=1500, help='Высота холста')

    # Add node command
    add_node_parser = subparsers.add_parser('add-node', help='Добавить узел')
    add_node_parser.add_argument('label', help='Текст узла')
    add_node_parser.add_argument('x', type=float, help='Координата X')
    add_node_parser.add_argument('y', type=float, help='Координата Y')
    add_node_parser.add_argument('--id', help='ID узла (для связей)')
    add_node_parser.add_argument('--shape', choices=['rectangle', 'rounded', 'circle', 'diamond', 'cylinder'],
                                  default='rounded', help='Форма узла')
    add_node_parser.add_argument('--width', type=float, default=180, help='Ширина')
    add_node_parser.add_argument('--height', type=float, default=80, help='Высота')
    add_node_parser.add_argument('--color', choices=['blue', 'green', 'yellow', 'purple', 'red', 'gray'],
                                  default='blue', help='Цветовая палитра')
    add_node_parser.add_argument('--bold', action='store_true', help='Жирный текст')
    add_node_parser.add_argument('--file', required=True, help='Файл .unidraw')

    # Add text command
    add_text_parser = subparsers.add_parser('add-text', help='Добавить текст')
    add_text_parser.add_argument('text', help='Текст')
    add_text_parser.add_argument('x', type=float, help='Координата X')
    add_text_parser.add_argument('y', type=float, help='Координата Y')
    add_text_parser.add_argument('--width', type=float, default=400, help='Ширина текстового блока')
    add_text_parser.add_argument('--height', type=float, default=40, help='Высота')
    add_text_parser.add_argument('--color', type=str, default='#3A3A3A', help='Цвет текста')
    add_text_parser.add_argument('--font-size', type=int, default=20, help='Размер шрифта')
    add_text_parser.add_argument('--align', type=str, default='l', choices=['l', 'c', 'r', 'm'],
                                  help='Выравнивание')
    add_text_parser.add_argument('--bold', action='store_true', help='Жирный текст')
    add_text_parser.add_argument('--file', required=True, help='Файл .unidraw')

    # Connect command
    connect_parser = subparsers.add_parser('connect', help='Добавить связь между узлами')
    connect_parser.add_argument('source', help='ID исходного узла')
    connect_parser.add_argument('target', help='ID целевого узла')
    connect_parser.add_argument('--label', help='Подпись связи')
    connect_parser.add_argument('--line-type', choices=['straight', 'curved', 'orthogonal'],
                                 default='straight', help='Тип линии')
    connect_parser.add_argument('--line-style', choices=['s', 'do', 'da'], default='s',
                                 help='Стиль линии (solid/dotted/dashed)')
    connect_parser.add_argument('--line-width', type=int, default=2, help='Толщина линии')
    connect_parser.add_argument('--line-color', type=str, default='#3A3A3A', help='Цвет линии')
    connect_parser.add_argument('--arrow-start', choices=['none', 'arrow', 'triangle', 'diamond', 'circle'],
                                 default='none', help='Наконечник на начале')
    connect_parser.add_argument('--arrow-end', choices=['none', 'arrow', 'triangle', 'diamond', 'circle'],
                                 default='arrow', help='Наконечник на конце')
    connect_parser.add_argument('--source-anchor', choices=['north', 'south', 'east', 'west', 'center'],
                                 default='east', help='Точка привязки источника')
    connect_parser.add_argument('--target-anchor', choices=['north', 'south', 'east', 'west', 'center'],
                                 default='west', help='Точка привязки цели')
    connect_parser.add_argument('--file', required=True, help='Файл .unidraw')

    # Draw command
    draw_parser = subparsers.add_parser('draw', help='Нарисовать диаграмму из описания')
    draw_parser.add_argument('description', nargs='?', help='Описание диаграммы')
    draw_parser.add_argument('--file', help='Файл с описанием диаграммы')
    draw_parser.add_argument('--output', '-o', help='Выходной файл')
    draw_parser.add_argument('--width', type=int, default=2000, help='Ширина холста')
    draw_parser.add_argument('--height', type=int, default=1500, help='Высота холста')
    draw_parser.add_argument('--auto-size', action='store_true', help='Авто-размер холста')

    # Layout command
    layout_parser = subparsers.add_parser('layout', help='Применить раскладку к элементам')
    layout_parser.add_argument('layout', choices=['horizontal', 'vertical', 'grid'],
                                help='Тип раскладки')
    layout_parser.add_argument('--elements', required=True, help='Список ID элементов через запятую')
    layout_parser.add_argument('--x', type=int, default=50, help='Начальная X')
    layout_parser.add_argument('--y', type=int, default=100, help='Начальная Y')
    layout_parser.add_argument('--spacing', type=int, default=50, help='Отступ между элементами')
    layout_parser.add_argument('--cols', type=int, default=3, help='Колонок для grid')
    layout_parser.add_argument('--file', required=True, help='Файл .unidraw')

    # Export command
    export_parser = subparsers.add_parser('export', help='Экспорт в формат')
    export_parser.add_argument('format', choices=['png', 'json'], help='Формат экспорта')
    export_parser.add_argument('output', help='Выходной файл')
    export_parser.add_argument('--file', required=True, help='Файл .unidraw')

    # Load command
    load_parser = subparsers.add_parser('load', help='Загрузить и показать whiteboard')
    load_parser.add_argument('file', help='Файл .unidraw')

    # List command
    list_parser = subparsers.add_parser('list', help='Показать элементы whiteboard')
    list_parser.add_argument('file', help='Файл .unidraw')

    args = parser.parse_args()

    if args.command == 'create':
        cmd_create(args)
    elif args.command == 'add-node':
        cmd_add_node(args)
    elif args.command == 'add-text':
        cmd_add_text(args)
    elif args.command == 'connect':
        cmd_connect(args)
    elif args.command == 'draw':
        cmd_draw(args)
    elif args.command == 'layout':
        cmd_layout(args)
    elif args.command == 'export':
        cmd_export(args)
    elif args.command == 'load':
        cmd_load(args)
    elif args.command == 'list':
        cmd_list(args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
