"""Read layout metadata for the tty selected by kitty's remote-control matcher."""
import json

from kittens.tui.handler import result_handler


def main(args):
    pass


@result_handler(no_ui=True)
def handle_result(args, answer, target_window_id, boss):
    from kitty.fast_data_types import get_os_window_pos, get_os_window_size
    from kitty.utils import platform_window_id

    window = boss.window_id_map.get(target_window_id)
    if window is None:
        return None
    tab = window.tabref()
    manager = boss.os_window_map.get(window.os_window_id)
    size = get_os_window_size(window.os_window_id)
    position = get_os_window_pos(window.os_window_id)
    if tab is None or manager is None or size is None:
        return None
    screen = window.screen
    geometry = window.geometry
    return json.dumps({
        "window": platform_window_id(window.os_window_id),
        "rootPID": window.child.root_pid,
        "selected": manager.active_tab is tab and window.is_visible_in_layout,
        "history": screen.scrolled_by > 0,
        "decorated": geometry.ynum != screen.lines,
        "columns": screen.columns,
        "rows": screen.lines,
        "x": position[0],
        "y": position[1],
        "left": geometry.left,
        "top": geometry.top,
        "width": size["cell_width"],
        "height": size["cell_height"],
        "scaleX": size["framebuffer_width"] / size["width"],
        "scaleY": size["framebuffer_height"] / size["height"],
    })
