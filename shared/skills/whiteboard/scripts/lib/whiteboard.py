"""
Whiteboard library - полная поддержка связей и генерации диаграмм
Совместимо с whiteboard.t-tech.team форматом
"""

import json
import sys
import uuid
import time
import random
import math
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass, field
from enum import Enum


# ============================================================================
# Утилиты
# ============================================================================

def generate_id() -> str:
    """Generate a unique element ID (21 char, URL-safe)"""
    return ''.join(random.choices('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_', k=21))


def get_timestamp() -> int:
    """Get current timestamp in milliseconds"""
    return int(time.time() * 1000)


def get_version_nonce() -> int:
    """Generate a random version nonce"""
    return random.randint(0, 2147483647)


def get_seed() -> int:
    """Generate a random seed"""
    return random.randint(0, 2147483647)


# ============================================================================
# Перечисления
# ============================================================================

class ShapeType(Enum):
    RECTANGLE = "1"
    ROUNDED = "2"
    CIRCLE = "3"
    DIAMOND = "5"
    PARALLELOGRAM = "6"
    CLOUD = "7"
    CYLINDER = "8"  # для баз данных


class LineStyle(Enum):
    SOLID = "s"
    DOTTED = "do"
    DASHED = "da"


class LineType(Enum):
    STRAIGHT = "straight"
    CURVED = "curved"
    ORTHOGONAL = "orthogonal"


class ArrowType(Enum):
    NONE = "none"
    ARROW = "arrow"      # классическая стрелка
    TRIANGLE = "triangle"  # закрытый треугольник
    DIAMOND = "diamond"    # ромб (агрегация)
    CIRCLE = "circle"      # круг (включение)


class TextAlign(Enum):
    LEFT = "l"
    CENTER = "c"
    RIGHT = "r"
    MIDDLE = "m"


class VerticalAlign(Enum):
    TOP = "t"
    MIDDLE = "m"
    BOTTOM = "b"


# ============================================================================
# Стили
# ============================================================================

@dataclass
class Style:
    """Style configuration for whiteboard elements"""
    # Text styles
    tc: str = "#3A3A3A"      # text color
    tff: str = "Neue Haas Unica, Segoe UI Emoji"  # font family
    tfs: int = 20            # font size
    ta: str = "l"            # text align: l, c, r, m
    tva: str = "m"           # vertical align: t, m, b

    # Fill styles
    fc: str = "transparent"  # fill color
    fs: str = "s"            # fill style: s, m, l, h, c

    # Stroke styles
    sc: str = "#3A3A3A"      # stroke color
    sw: int = 2              # stroke width
    ss: str = "s"            # stroke style: s, do, da

    # Additional
    tfsa: bool = False       # text font size auto
    opacity: float = 1.0     # opacity 0-1

    # Для связей
    curve: float = 0.0       # кривизна линии (0-1)
    arrow_start: str = "none"  # тип наконечника на начале
    arrow_end: str = "none"    # тип наконечника на конце

    def to_dict(self, include_stroke: bool = True, include_fill: bool = True) -> dict:
        result = {
            "tc": self.tc,
            "tff": self.tff,
            "tfs": self.tfs,
            "ta": self.ta,
            "tva": self.tva,
        }

        if include_fill:
            result["fc"] = self.fc
            result["fs"] = self.fs

        if include_stroke:
            result["sc"] = self.sc
            result["sw"] = self.sw
            result["ss"] = self.ss

        if self.tfsa:
            result["tfsa"] = self.tfsa

        return result

    def copy(self) -> "Style":
        return Style(**self.__dict__)


# ============================================================================
# Базовый элемент
# ============================================================================

@dataclass
class Element:
    """Base class for all whiteboard elements"""
    id: str = field(default_factory=generate_id)
    type: str = "element"
    position: Dict[str, float] = field(default_factory=lambda: {"x": 0, "y": 0})
    size: Dict[str, float] = field(default_factory=lambda: {"width": 100, "height": 100})
    version: int = 1
    version_nonce: int = field(default_factory=get_version_nonce)
    created_at: int = field(default_factory=get_timestamp)
    updated_at: int = field(default_factory=get_timestamp)
    created_by: str = field(default_factory=lambda: str(uuid.uuid4()))
    alpha: int = 100
    z_index: int = 0
    rotation: int = 0
    group_ids: List[str] = field(default_factory=list)
    is_locked: bool = False
    is_deleted: bool = False
    is_dto: bool = True
    schema: int = 2
    text: str = "<p></p>"
    style: Style = field(default_factory=Style)
    is_author_visible: bool = False

    def set_position(self, x: float, y: float):
        self.position["x"] = x
        self.position["y"] = y
        return self

    def set_size(self, width: float, height: float):
        self.size["width"] = width
        self.size["height"] = height
        return self

    def set_z_index(self, z_index: int):
        self.z_index = z_index
        return self

    def bump_version(self):
        self.version += 1
        self.version_nonce = get_version_nonce()
        self.updated_at = get_timestamp()
        return self

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "position": self.position,
            "size": self.size,
            "version": self.version,
            "versionNonce": self.version_nonce,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "createdBy": self.created_by,
            "alpha": self.alpha,
            "zIndex": self.z_index,
            "rotation": self.rotation,
            "groupIds": self.group_ids,
            "isLocked": self.is_locked,
            "isDeleted": self.is_deleted,
            "isDTO": self.is_dto,
            "type": self.type,
            "schema": self.schema,
            "text": self.text,
            "style": self.style.to_dict(),
            "isAuthorVisible": self.is_author_visible,
        }


# ============================================================================
# Фигуры
# ============================================================================

@dataclass
class Shape(Element):
    """Represents a shape on the whiteboard"""
    shape: str = "1"  # 1=rectangle, 2=rounded, 3=circle, 5=diamond
    seed: int = field(default_factory=get_seed)
    roughness: int = 0

    def __post_init__(self):
        self.type = "shape"
        self.style.sc = "#3A3A3A"  # ensure stroke color for shapes
        self.style.sw = 2

    def to_dict(self) -> dict:
        data = super().to_dict()
        data["shape"] = self.shape
        data["seed"] = self.seed
        data["roughness"] = self.roughness
        return data


@dataclass
class TextElement(Element):
    """Represents text on the whiteboard"""

    def __post_init__(self):
        self.type = "text"
        if not self.text.startswith("<"):
            self.text = f"<p>{self.text}</p>"

    def to_dict(self) -> dict:
        data = super().to_dict()
        # Remove stroke/fill properties for text
        style_dict = data["style"]
        style_dict.pop("sc", None)
        style_dict.pop("sw", None)
        style_dict.pop("ss", None)
        style_dict.pop("fc", None)
        style_dict.pop("fs", None)
        return data


@dataclass
class Sticker(Element):
    """Represents a sticker (colored box with emoji/text)"""

    def __post_init__(self):
        self.type = "sticker"
        self.style.tfs = 114
        self.style.ta = "m"
        self.style.tva = "m"
        self.style.tfsa = True


@dataclass
class Connection(Element):
    """
    Represents a connection/edge between two elements.
    Supports various line types and arrow heads.
    """
    # Точки привязки (координаты или ссылки на элементы)
    source_id: str = ""
    target_id: str = ""
    source_anchor: str = "east"   # north, south, east, west, center
    target_anchor: str = "west"

    # Точки линии (для кривых и ортогональных)
    points: List[List[float]] = field(default_factory=list)

    # Типы линии
    line_type: str = "straight"   # straight, curved, orthogonal
    line_style: str = "s"         # s, do, da
    line_width: int = 2
    line_color: str = "#3A3A3A"

    # Наконечники
    arrow_start: str = "none"     # none, arrow, triangle, diamond, circle
    arrow_end: str = "none"

    # Подпись
    label: str = ""
    label_position: float = 0.5   # 0-1, позиция вдоль линии

    def __post_init__(self):
        self.type = "connection"

    def to_dict(self) -> dict:
        data = super().to_dict()
        data["sourceId"] = self.source_id
        data["targetId"] = self.target_id
        data["sourceAnchor"] = self.source_anchor
        data["targetAnchor"] = self.target_anchor
        data["points"] = self.points if self.points else []
        data["lineType"] = self.line_type
        data["lineStyle"] = self.line_style
        data["lineWidth"] = self.line_width
        data["lineColor"] = self.line_color
        data["arrowStart"] = self.arrow_start
        data["arrowEnd"] = self.arrow_end
        data["label"] = self.label
        data["labelPosition"] = self.label_position

        # Стиль для connection
        data["style"] = {
            "sc": self.line_color,
            "sw": self.line_width,
            "ss": self.line_style,
        }

        return data


# ============================================================================
# Whiteboard
# ============================================================================

class Whiteboard:
    """Main whiteboard class that contains all elements"""

    # Цветовые палитры
    PALETTES = {
        "blue": {"fill": "#dbeafe", "stroke": "#2563eb", "text": "#1e40af"},
        "green": {"fill": "#d1fae5", "stroke": "#059669", "text": "#065f46"},
        "yellow": {"fill": "#fef3c7", "stroke": "#d97706", "text": "#92400e"},
        "purple": {"fill": "#e9d5ff", "stroke": "#9333ea", "text": "#6b21a8"},
        "red": {"fill": "#fee2e2", "stroke": "#dc2626", "text": "#991b1b"},
        "gray": {"fill": "#f3f4f6", "stroke": "#6b7280", "text": "#374151"},
    }

    # Размеры по умолчанию
    DEFAULT_WIDTH = 2000
    DEFAULT_HEIGHT = 1500
    DEFAULT_NODE_WIDTH = 180
    DEFAULT_NODE_HEIGHT = 80
    NODE_SPACING = 50

    def __init__(self, width: int = DEFAULT_WIDTH, height: int = DEFAULT_HEIGHT):
        self.elements: List[Element] = []
        self.connections: List[Connection] = []
        self.width = width
        self.height = height
        self.source = "https://whiteboard.t-tech.team"
        self.version = 1
        self.app_state = {"viewBackgroundColor": "#FFFFFF"}
        self.files = {}
        self._next_z_index = 1
        self._element_index: Dict[str, Element] = {}  # для быстрого поиска

    # -------------------------------------------------------------------------
    # Базовые операции
    # -------------------------------------------------------------------------

    def add_element(self, element: Element) -> "Whiteboard":
        """Add an element to the whiteboard"""
        element.set_z_index(self._next_z_index)
        self._next_z_index += 1
        self.elements.append(element)
        if element.id:
            self._element_index[element.id] = element
        return self

    def get_element(self, element_id: str) -> Optional[Element]:
        """Get element by ID"""
        return self._element_index.get(element_id)

    def remove_element(self, element_id: str):
        """Remove an element by ID"""
        if element_id in self._element_index:
            elem = self._element_index.pop(element_id)
            self.elements.remove(elem)
            # Remove connections to/from this element
            self.connections = [
                c for c in self.connections
                if c.source_id != element_id and c.target_id != element_id
            ]

    def add_connection(
        self,
        source: str,
        target: str,
        label: str = "",
        line_type: str = "straight",
        line_style: str = "s",
        line_width: int = 2,
        line_color: str = "#3A3A3A",
        arrow_start: str = "none",
        arrow_end: str = "arrow",
        source_anchor: str = "east",
        target_anchor: str = "west",
    ) -> "Whiteboard":
        """
        Add a connection between two elements.

        Args:
            source: ID of source element
            target: ID of target element
            label: Optional label text
            line_type: straight, curved, orthogonal
            line_style: s (solid), do (dotted), da (dashed)
            line_width: stroke width
            line_color: hex color
            arrow_start/arrow_end: none, arrow, triangle, diamond, circle
            source_anchor: north, south, east, west
            target_anchor: north, south, east, west
        """
        conn = Connection(
            source_id=source,
            target_id=target,
            label=label,
            line_type=line_type,
            line_style=line_style,
            line_width=line_width,
            line_color=line_color,
            arrow_start=arrow_start,
            arrow_end=arrow_end,
            source_anchor=source_anchor,
            target_anchor=target_anchor,
        )
        conn.set_z_index(self._next_z_index)
        self._next_z_index += 1
        self.connections.append(conn)
        return self

    # -------------------------------------------------------------------------
    # Фабричные методы для элементов
    # -------------------------------------------------------------------------

    def create_node(
        self,
        id: str,
        label: str,
        x: float,
        y: float,
        width: float = DEFAULT_NODE_WIDTH,
        height: float = DEFAULT_NODE_HEIGHT,
        shape: str = "1",
        color_palette: str = "blue",
        font_size: int = 18,
        bold: bool = False,
    ) -> "Whiteboard":
        """Create a node (shape with text)"""
        palette = self.PALETTES.get(color_palette, self.PALETTES["blue"])

        style = Style(
            tc=palette["text"],
            tfs=font_size,
            ta="c",
            tva="m",
            fc=palette["fill"],
            sc=palette["stroke"],
            sw=2,
        )

        text = f"<p><b>{label}</b></p>" if bold else f"<p>{label}</p>"

        node = Shape(
            shape=shape,
            text=text,
            style=style,
        )
        node.id = id
        node.position = {"x": x, "y": y}
        node.size = {"width": width, "height": height}
        return self.add_element(node)

    def create_text(
        self,
        text: str,
        x: float,
        y: float,
        width: float = 400,
        height: float = 40,
        color: str = "#3A3A3A",
        font_size: int = 20,
        text_align: str = "l",
        bold: bool = False,
    ) -> "Whiteboard":
        """Create and add text"""
        display_text = text
        if not text.startswith("<"):
            if bold:
                display_text = f"<p><b>{text}</b></p>"
            else:
                display_text = f"<p>{text}</p>"

        style = Style(
            tc=color,
            tfs=font_size,
            ta=text_align,
        )
        text_elem = TextElement(text=display_text, style=style)
        text_elem.position = {"x": x, "y": y}
        text_elem.size = {"width": width, "height": height}
        return self.add_element(text_elem)

    def create_container(
        self,
        id: str,
        label: str,
        x: float,
        y: float,
        width: float,
        height: float,
        color_palette: str = "gray",
    ) -> "Whiteboard":
        """Create a container (grouping box)"""
        palette = self.PALETTES.get(color_palette, self.PALETTES["gray"])

        style = Style(
            tc=palette["text"],
            tfs=14,
            ta="l",
            tva="t",
            fc=palette["fill"],
            sc=palette["stroke"],
            sw=2,
            ss="da",  # dashed border for containers
        )

        container = Shape(shape="2", text=f"<p>{label}</p>", style=style)
        container.id = id
        container.position = {"x": x, "y": y}
        container.size = {"width": width, "height": height}
        return self.add_element(container)

    def create_database(
        self,
        id: str,
        label: str,
        x: float,
        y: float,
        color_palette: str = "purple",
    ) -> "Whiteboard":
        """Create a database icon (cylinder shape)"""
        return self.create_node(
            id=id,
            label=label,
            x=x,
            y=y,
            shape="8",  # cylinder
            color_palette=color_palette,
            width=140,
            height=100,
        )

    def create_user(
        self,
        id: str,
        label: str,
        x: float,
        y: float,
    ) -> "Whiteboard":
        """Create a user actor (circle)"""
        return self.create_node(
            id=id,
            label=label,
            x=x,
            y=y,
            shape="3",  # circle
            color_palette="green",
            width=100,
            height=100,
            bold=True,
        )

    def create_component(
        self,
        id: str,
        label: str,
        x: float,
        y: float,
        tech: str = "",
    ) -> "Whiteboard":
        """Create a component (rounded rectangle)"""
        return self.create_node(
            id=id,
            label=f"{label}\n{tech}" if tech else label,
            x=x,
            y=y,
            shape="2",  # rounded
            color_palette="blue",
            width=160,
            height=70,
        )

    # -------------------------------------------------------------------------
    # Авто-раскладка
    # -------------------------------------------------------------------------

    def layout_horizontal(
        self,
        element_ids: List[str],
        start_x: float = 50,
        start_y: float = 100,
        spacing: float = 50,
    ) -> "Whiteboard":
        """Arrange elements horizontally"""
        x = start_x
        for elem_id in element_ids:
            elem = self.get_element(elem_id)
            if elem:
                elem.position["x"] = x
                elem.position["y"] = start_y
                x += elem.size["width"] + spacing
        return self

    def layout_vertical(
        self,
        element_ids: List[str],
        start_x: float = 100,
        start_y: float = 50,
        spacing: float = 50,
    ) -> "Whiteboard":
        """Arrange elements vertically"""
        y = start_y
        for elem_id in element_ids:
            elem = self.get_element(elem_id)
            if elem:
                elem.position["x"] = start_x
                elem.position["y"] = y
                y += elem.size["height"] + spacing
        return self

    def layout_grid(
        self,
        element_ids: List[str],
        start_x: float = 50,
        start_y: float = 50,
        cols: int = 3,
        spacing_x: float = 50,
        spacing_y: float = 50,
    ) -> "Whiteboard":
        """Arrange elements in a grid"""
        x = start_x
        y = start_y
        max_height = 0
        col_count = 0

        for elem_id in element_ids:
            elem = self.get_element(elem_id)
            if elem:
                elem.position["x"] = x
                elem.position["y"] = y
                max_height = max(max_height, elem.size["height"])
                col_count += 1

                if col_count >= cols:
                    x = start_x
                    y += max_height + spacing_y
                    max_height = 0
                    col_count = 0
                else:
                    x += elem.size["width"] + spacing_x

        return self

    # -------------------------------------------------------------------------
    # Вычисление точек для связей
    # -------------------------------------------------------------------------

    def _get_anchor_point(
        self,
        element: Element,
        anchor: str
    ) -> Tuple[float, float]:
        """Get the anchor point on an element"""
        x = element.position["x"]
        y = element.position["y"]
        w = element.size["width"]
        h = element.size["height"]

        anchors = {
            "north": (x + w / 2, y),
            "south": (x + w / 2, y + h),
            "east": (x + w, y + h / 2),
            "west": (x, y + h / 2),
            "center": (x + w / 2, y + h / 2),
            "northeast": (x + w, y),
            "northwest": (x, y),
            "southeast": (x + w, y + h),
            "southwest": (x, y + h),
        }
        return anchors.get(anchor, anchors["center"])

    def _calculate_connection_points(self, conn: Connection) -> List[List[float]]:
        """Calculate the points for a connection"""
        source = self.get_element(conn.source_id)
        target = self.get_element(conn.target_id)

        if not source or not target:
            return []

        start = self._get_anchor_point(source, conn.source_anchor)
        end = self._get_anchor_point(target, conn.target_anchor)

        if conn.line_type == "straight":
            return [list(start), list(end)]

        elif conn.line_type == "curved":
            # Bezier curve control points
            mid_x = (start[0] + end[0]) / 2
            mid_y = (start[1] + end[1]) / 2
            offset = abs(end[0] - start[0]) * 0.2
            return [
                list(start),
                [mid_x - offset, mid_y],
                [mid_x + offset, mid_y],
                list(end),
            ]

        elif conn.line_type == "orthogonal":
            # Right-angle path
            points = []

            # Determine path based on anchors
            if conn.source_anchor in ["east", "west"]:
                # Horizontal first
                mid_x = (start[0] + end[0]) / 2
                points = [
                    list(start),
                    [mid_x, start[1]],
                    [mid_x, end[1]],
                    list(end),
                ]
            else:
                # Vertical first
                mid_y = (start[1] + end[1]) / 2
                points = [
                    list(start),
                    [start[0], mid_y],
                    [end[0], mid_y],
                    list(end),
                ]

            return points

        return [list(start), list(end)]

    # -------------------------------------------------------------------------
    # Сериализация
    # -------------------------------------------------------------------------

    def to_dict(self) -> dict:
        result = {
            "type": "unidraw",
            "version": self.version,
            "source": self.source,
            "elements": [elem.to_dict() for elem in self.elements],
        }

        # Add connections as a separate array
        if self.connections:
            result["connections"] = [conn.to_dict() for conn in self.connections]

        return result

    @classmethod
    def from_dict(cls, data: dict) -> "Whiteboard":
        wb = cls(
            width=data.get("width", cls.DEFAULT_WIDTH),
            height=data.get("height", cls.DEFAULT_HEIGHT),
        )
        wb.source = data.get("source", "https://whiteboard.t-tech.team")
        wb.version = data.get("version", 1)

        # Restore elements
        elements_data = data.get("elements", [])
        for elem_data in elements_data:
            elem = cls._deserialize_element(elem_data)
            if elem:
                wb.elements.append(elem)
                wb._element_index[elem.id] = elem

        # Restore connections
        connections_data = data.get("connections", [])
        for conn_data in connections_data:
            conn = cls._deserialize_connection(conn_data)
            if conn:
                wb.connections.append(conn)

        return wb

    @classmethod
    def _deserialize_element(cls, data: dict) -> Optional[Element]:
        """Deserialize an element from dict"""
        elem_type = data.get("type")

        if elem_type == "shape":
            style = cls._deserialize_style(data.get("style", {}))
            elem = Shape(
                shape=data.get("shape", "1"),
                text=data.get("text", "<p></p>"),
                style=style,
            )
            elem.id = data.get("id", generate_id())
            elem.position = data.get("position", {"x": 0, "y": 0})
            elem.size = data.get("size", {"width": 100, "height": 100})
            elem.z_index = data.get("zIndex", 0)
            return elem

        elif elem_type == "text":
            style = cls._deserialize_style(data.get("style", {}))
            elem = TextElement(
                text=data.get("text", "<p></p>"),
                style=style,
            )
            elem.id = data.get("id", generate_id())
            elem.position = data.get("position", {"x": 0, "y": 0})
            elem.size = data.get("size", {"width": 400, "height": 40})
            elem.z_index = data.get("zIndex", 0)
            return elem

        elif elem_type == "connection":
            return cls._deserialize_connection(data)

        return None

    @classmethod
    def _deserialize_style(cls, data: dict) -> Style:
        """Deserialize style from dict"""
        return Style(
            tc=data.get("tc", "#3A3A3A"),
            tfs=data.get("tfs", 20),
            ta=data.get("ta", "l"),
            tva=data.get("tva", "m"),
            fc=data.get("fc", "transparent"),
            sc=data.get("sc", "#3A3A3A"),
            sw=data.get("sw", 2),
            ss=data.get("ss", "s"),
        )

    @classmethod
    def _deserialize_connection(cls, data: dict) -> Optional[Connection]:
        """Deserialize a connection from dict"""
        conn = Connection(
            source_id=data.get("sourceId", ""),
            target_id=data.get("targetId", ""),
            label=data.get("label", ""),
            line_type=data.get("lineType", "straight"),
            line_style=data.get("lineStyle", "s"),
            line_width=data.get("lineWidth", 2),
            line_color=data.get("lineColor", "#3A3A3A"),
            arrow_start=data.get("arrowStart", "none"),
            arrow_end=data.get("arrowEnd", "none"),
            source_anchor=data.get("sourceAnchor", "east"),
            target_anchor=data.get("targetAnchor", "west"),
        )
        conn.id = data.get("id", generate_id())
        conn.z_index = data.get("zIndex", 0)
        conn.points = data.get("points", [])
        return conn

    def save(self, file_path: str):
        """Save the whiteboard to a .unidraw file"""
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(self.to_dict(), f, indent=2, ensure_ascii=False)
        except Exception as e:
            raise Exception(f"Error saving whiteboard: {e}")

    @classmethod
    def load(cls, file_path: str) -> "Whiteboard":
        """Load a whiteboard from a .unidraw file"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return cls.from_dict(data)
        except FileNotFoundError:
            raise Exception(f"Error: File {file_path} not found")
        except json.JSONDecodeError:
            raise Exception(f"Error: Invalid JSON in file {file_path}")
        except Exception as e:
            raise Exception(f"Error loading whiteboard: {e}")

    # -------------------------------------------------------------------------
    # Утилиты
    # -------------------------------------------------------------------------

    def auto_size_canvas(self, padding: float = 100):
        """Auto-size canvas to fit all elements"""
        if not self.elements:
            return

        min_x = min_y = float('inf')
        max_x = max_y = 0

        for elem in self.elements:
            x = elem.position["x"]
            y = elem.position["y"]
            w = elem.size["width"]
            h = elem.size["height"]

            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x + w)
            max_y = max(max_y, y + h)

        self.width = int(max_x - min_x + padding * 2)
        self.height = int(max_y - min_y + padding * 2)

        # Shift all elements if needed
        if min_x < 0 or min_y < 0:
            for elem in self.elements:
                elem.position["x"] = max(padding, elem.position["x"] - min_x + padding)
                elem.position["y"] = max(padding, elem.position["y"] - min_y + padding)

        return self

    def clear(self):
        """Clear all elements and connections"""
        self.elements = []
        self.connections = []
        self._element_index = {}
        self._next_z_index = 1
        return self
