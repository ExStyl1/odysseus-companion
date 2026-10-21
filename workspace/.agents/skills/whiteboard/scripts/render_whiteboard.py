#!/usr/bin/env python3
"""
Render a .unidraw whiteboard file to PNG using Pillow
Supports: shapes, text, connections (with arrows), containers
"""

import json
import sys
import math
from PIL import Image, ImageDraw, ImageFont


# ============================================================================
# Fonts
# ============================================================================

def get_font(size, bold=False):
    """Get a font, falling back to default if necessary"""
    font_paths = [
        ("/System/Library/Fonts/Helvetica.ttc", size, bold),
        ("/System/Library/Fonts/Helvetica.ttc", size * 1.2, False),  # bold fallback
        ("/System/Library/Fonts/Arial.ttf", size, bold),
        ("/System/Library/Fonts/Arial Bold.ttf", size, False),
        ("/System/Library/Fonts/HelveticaNeue.ttc", size, bold),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size, bold),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size, False),
    ]

    for font_path, font_size, is_bold in font_paths:
        try:
            # Try exact match first
            if is_bold == bold:
                return ImageFont.truetype(font_path, int(font_size))
        except (IOError, OSError):
            continue

    return ImageFont.load_default()


# ============================================================================
# Color utilities
# ============================================================================

def hex_to_rgb(hex_color):
    """Convert hex color to RGB tuple"""
    if not hex_color or hex_color == "transparent":
        return None
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 3:
        hex_color = ''.join([c * 2 for c in hex_color])
    try:
        return tuple(int(hex_color[i:i + 2], 16) for i in (0, 2, 4))
    except:
        return (0, 0, 0)


def parse_text(text):
    """Parse HTML-like text and extract plain text with formatting"""
    if not text:
        return "", False

    # Remove <p> tags
    result = text.replace("<p>", "").replace("</p>", "")

    # Check for bold
    is_bold = "<b>" in result or "<strong>" in result
    result = result.replace("<b>", "").replace("</b>", "")
    result = result.replace("<strong>", "").replace("</strong>", "")

    # Handle line breaks
    lines = result.split('\n')

    return lines, is_bold


# ============================================================================
# Arrow drawing
# ============================================================================

def draw_arrow(draw, start, end, color, width=2, arrow_type="arrow", arrow_size=10):
    """
    Draw a line with an arrow head.

    arrow_type: none, arrow, triangle, diamond, circle
    """
    x1, y1 = start
    x2, y2 = end

    # Draw the line
    draw.line([start, end], fill=color, width=width)

    if arrow_type == "none":
        return

    # Calculate angle
    angle = math.atan2(y2 - y1, x2 - x1)

    if arrow_type == "arrow":
        # Classic open arrow
        arrow_angle = math.pi / 6  # 30 degrees
        left_x = x2 - arrow_size * math.cos(angle - arrow_angle)
        left_y = y2 - arrow_size * math.sin(angle - arrow_angle)
        right_x = x2 - arrow_size * math.cos(angle + arrow_angle)
        right_y = y2 - arrow_size * math.sin(angle + arrow_angle)

        draw.line([(x2, y2), (left_x, left_y)], fill=color, width=width)
        draw.line([(x2, y2), (right_x, right_y)], fill=color, width=width)

    elif arrow_type == "triangle":
        # Filled triangle
        arrow_angle = math.pi / 4  # 45 degrees
        left_x = x2 - arrow_size * math.cos(angle - arrow_angle)
        left_y = y2 - arrow_size * math.sin(angle - arrow_angle)
        right_x = x2 - arrow_size * math.cos(angle + arrow_angle)
        right_y = y2 - arrow_size * math.sin(angle + arrow_angle)

        draw.polygon([(x2, y2), (left_x, left_y), (right_x, right_y)], fill=color)

    elif arrow_type == "diamond":
        # Diamond (aggregation)
        diamond_size = arrow_size * 1.5
        points = [
            (x2, y2),
            (x2 - diamond_size * math.cos(angle - math.pi/2),
             y2 - diamond_size * math.sin(angle - math.pi/2)),
            (x2 - 2 * diamond_size * math.cos(angle),
             y2 - 2 * diamond_size * math.sin(angle)),
            (x2 - diamond_size * math.cos(angle + math.pi/2),
             y2 - diamond_size * math.sin(angle + math.pi/2)),
        ]
        draw.polygon(points, outline=color)

    elif arrow_type == "circle":
        # Circle (composition)
        circle_x = x2 - arrow_size * math.cos(angle)
        circle_y = y2 - arrow_size * math.sin(angle)
        draw.ellipse(
            [circle_x - arrow_size, circle_y - arrow_size,
             circle_x + arrow_size, circle_y + arrow_size],
            outline=color, width=width
        )


def draw_curved_line(draw, points, color, width=2, line_style="s", arrow_end="none"):
    """Draw a curved line through control points"""
    if len(points) < 2:
        return

    # For Bezier curves, we need to interpolate
    if len(points) == 4:  # Cubic Bezier
        p0, p1, p2, p3 = points
        num_segments = 50

        prev = None
        for i in range(num_segments + 1):
            t = i / num_segments
            # Cubic Bezier formula
            x = ((1 - t) ** 3) * p0[0] + 3 * ((1 - t) ** 2) * t * p1[0] + \
                3 * (1 - t) * (t ** 2) * p2[0] + (t ** 3) * p3[0]
            y = ((1 - t) ** 3) * p0[1] + 3 * ((1 - t) ** 2) * t * p1[1] + \
                3 * (1 - t) * (t ** 2) * p2[1] + (t ** 3) * p3[1]

            curr = (x, y)
            if prev:
                draw.line([prev, curr], fill=color, width=width)
            prev = curr

        # Draw arrow at end
        if arrow_end != "none":
            # Use last segment for arrow direction
            draw.line([prev, p3], fill=color, width=width)
            # Calculate tangent at end
            t = 0.99
            x1 = ((1 - t) ** 3) * p0[0] + 3 * ((1 - t) ** 2) * t * p1[0] + \
                 3 * (1 - t) * (t ** 2) * p2[0] + (t ** 3) * p3[0]
            y1 = ((1 - t) ** 3) * p0[1] + 3 * ((1 - t) ** 2) * t * p1[1] + \
                 3 * (1 - t) * (t ** 2) * p2[1] + (t ** 3) * p3[1]
            draw_arrow(draw, (x1, y1), p3, color, width, arrow_end)
    else:
        # Simple curve through points
        for i in range(len(points) - 1):
            draw.line([points[i], points[i + 1]], fill=color, width=width)


def draw_orthogonal_line(draw, points, color, width=2, line_style="s", arrow_end="none"):
    """Draw orthogonal (right-angle) line"""
    if len(points) < 2:
        return

    # Draw line segments
    for i in range(len(points) - 1):
        draw.line([points[i], points[i + 1]], fill=color, width=width)

    # Draw arrow at end if needed
    if arrow_end != "none" and len(points) >= 2:
        p1 = points[-2]
        p2 = points[-1]
        draw_arrow(draw, p1, p2, color, width, arrow_end)


# ============================================================================
# Shape rendering
# ============================================================================

def draw_shape(draw, elem, font_default):
    """Draw a shape element"""
    x = elem.get("position", {}).get("x", 0)
    y = elem.get("position", {}).get("y", 0)
    w = elem.get("size", {}).get("width", 100)
    h = elem.get("size", {}).get("height", 100)

    style = elem.get("style", {})
    fill = style.get("fc", "transparent")
    stroke = style.get("sc", "#3A3A3A")
    stroke_width = style.get("sw", 2)
    shape_type = elem.get("shape", "1")

    fill_rgb = hex_to_rgb(fill)
    stroke_rgb = hex_to_rgb(stroke)

    # Shape bounding box
    bbox = [x, y, x + w, y + h]

    if shape_type == "1":  # Rectangle
        if fill_rgb:
            draw.rectangle(bbox, fill=fill_rgb, outline=stroke_rgb, width=stroke_width)
        else:
            draw.rectangle(bbox, outline=stroke_rgb, width=stroke_width)

    elif shape_type == "2":  # Rounded rectangle
        radius = min(w, h) * 0.15
        if fill_rgb:
            draw.rounded_rectangle(bbox, radius=radius, fill=fill_rgb,
                                   outline=stroke_rgb, width=stroke_width)
        else:
            draw.rounded_rectangle(bbox, radius=radius, outline=stroke_rgb,
                                   width=stroke_width)

    elif shape_type == "3":  # Circle/Ellipse
        if fill_rgb:
            draw.ellipse(bbox, fill=fill_rgb, outline=stroke_rgb, width=stroke_width)
        else:
            draw.ellipse(bbox, outline=stroke_rgb, width=stroke_width)

    elif shape_type == "5":  # Diamond
        cx, cy = x + w / 2, y + h / 2
        points = [
            (cx, y),           # top
            (x + w, cy),       # right
            (cx, y + h),       # bottom
            (x, cy),           # left
        ]
        if fill_rgb:
            draw.polygon(points, fill=fill_rgb, outline=stroke_rgb)
            draw.line([points[i] for i in range(len(points))],
                      outline=stroke_rgb, width=stroke_width, join=1)
        else:
            draw.polygon(points, outline=stroke_rgb, width=stroke_width)

    elif shape_type == "8":  # Cylinder (database)
        # Draw cylinder
        margin = w * 0.1
        top_ellipse = [x + margin, y, x + w - margin, y + h * 0.3]
        bottom_ellipse = [x + margin, y + h * 0.7, x + w - margin, y + h]

        # Top ellipse
        if fill_rgb:
            draw.ellipse(top_ellipse, fill=fill_rgb, outline=stroke_rgb, width=stroke_width)
            # Body
            draw.rectangle(
                [x + margin, y + h * 0.15, x + w - margin, y + h * 0.85],
                fill=fill_rgb, outline=None
            )
            # Bottom curve
            draw.arc([x + margin, y + h * 0.5, x + w - margin, y + h],
                     0, 180, fill=stroke_rgb, width=stroke_width)
        else:
            draw.ellipse(top_ellipse, outline=stroke_rgb, width=stroke_width)
            draw.rectangle(
                [x + margin, y + h * 0.15, x + w - margin, y + h * 0.85],
                outline=stroke_rgb, width=stroke_width
            )


def draw_text_element(draw, elem, font_default):
    """Draw a text element"""
    text_raw = elem.get("text", "")
    lines, is_bold = parse_text(text_raw)

    x = elem.get("position", {}).get("x", 0)
    y = elem.get("position", {}).get("y", 0)

    style = elem.get("style", {})
    font_size = style.get("tfs", 20)
    color = style.get("tc", "#3A3A3A")
    align = style.get("ta", "l")

    font = get_font(font_size, is_bold)
    color_rgb = hex_to_rgb(color) or (0, 0, 0)

    # Draw each line
    line_height = font_size * 1.3
    for i, line in enumerate(lines):
        draw_y = y + i * line_height

        # Get text width for alignment
        bbox = draw.textbbox((0, 0), line, font=font)
        text_width = bbox[2] - bbox[0]

        # Calculate starting x based on alignment
        if align == "c" or align == "m":
            draw_x = x - text_width / 2
        elif align == "r":
            draw_x = x - text_width
        else:
            draw_x = x

        draw.text((draw_x, draw_y), line, fill=color_rgb, font=font)


def draw_connection(draw, conn, font_default):
    """Draw a connection between elements"""
    points = conn.get("points", [])
    line_type = conn.get("lineType", "straight")
    line_style = conn.get("lineStyle", "s")
    line_width = conn.get("lineWidth", 2)
    line_color = conn.get("lineColor", "#3A3A3A")
    arrow_end = conn.get("arrowEnd", "none")
    arrow_start = conn.get("arrowStart", "none")
    label = conn.get("label", "")

    color_rgb = hex_to_rgb(line_color) or (0, 0, 0)

    if line_type == "straight" or len(points) == 2:
        # Straight line
        if len(points) >= 2:
            start, end = points[0], points[-1]
            draw.line([start, end], fill=color_rgb, width=line_width)

            # Draw arrows
            if arrow_start != "none" and len(points) >= 2:
                draw_arrow(draw, points[1], points[0], color_rgb, line_width, arrow_start)
            if arrow_end != "none" and len(points) >= 2:
                draw_arrow(draw, points[0], points[-1], color_rgb, line_width, arrow_end)

            # Draw label
            if label:
                mid_x = (start[0] + end[0]) / 2
                mid_y = (start[1] + end[1]) / 2
                font = get_font(14)
                bbox = draw.textbbox((0, 0), label, font=font)
                label_w = bbox[2] - bbox[0]
                label_h = bbox[3] - bbox[1]
                draw.text((mid_x - label_w / 2, mid_y - label_h / 2 - 10),
                          label, fill=color_rgb, font=font)

    elif line_type == "curved":
        draw_curved_line(draw, points, color_rgb, line_width, line_style, arrow_end)

    elif line_type == "orthogonal":
        draw_orthogonal_line(draw, points, color_rgb, line_width, line_style, arrow_end)


# ============================================================================
# Main render function
# ============================================================================

def render_whiteboard(data, output_path):
    """Render the whiteboard to PNG"""
    width = data.get("width", 1000)
    height = data.get("height", 720)
    elements = data.get("elements", [])
    connections = data.get("connections", [])

    # Auto-size canvas if not specified
    if width == 0 or height == 0:
        max_x = max((e.get("position", {}).get("x", 0) +
                     e.get("size", {}).get("width", 0)) for e in elements)
        max_y = max((e.get("position", {}).get("y", 0) +
                     e.get("size", {}).get("height", 0)) for e in elements)
        width = int(max_x + 50)
        height = int(max_y + 50)

    # Create image with white background
    img = Image.new('RGB', (width, height), color='#ffffff')
    draw = ImageDraw.Draw(img)

    # Sort elements by zIndex
    elements_sorted = sorted(elements, key=lambda e: e.get("zIndex", 0))

    # Separate by type
    shapes = [e for e in elements_sorted if e.get("type") == "shape"]
    texts = [e for e in elements_sorted if e.get("type") == "text"]

    # Draw connections first (behind everything)
    for conn in connections:
        draw_connection(draw, conn, None)

    # Draw shapes
    for elem in shapes:
        draw_shape(draw, elem, None)

    # Draw text
    for elem in texts:
        draw_text_element(draw, elem, None)

    # Save the image
    img.save(output_path, 'PNG')
    print(f"PNG exported: {output_path}")


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: python render_whiteboard.py <input.unidraw> <output.png>")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    with open(input_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    render_whiteboard(data, output_file)
