"""Browser entry points. Uses the same numerical engine as the desktop app."""
import json
from engine import (demo_scene, simulate, validate, shading_intervals,
                    make_footprint, make_bar_footprint, make_triangle_y_footprint,
                    rotate_footprint)
from season_dates import season_dates


def dispatch(raw):
    request = json.loads(raw)
    action = request['action']
    if action == 'init':
        scene = demo_scene()
        scene['observer_building'] = len(scene['buildings']) - 1
        return json.dumps(scene)
    if action == 'calculate':
        result = simulate(request['scene'], request['day'], 1,
                          request['buildings'], request['terrain'])
        result['intervals'] = shading_intervals(result['rows'])
        daylight = [r['minute'] for r in result['rows'] if r['baseline']]
        result['daylight'] = [daylight[0], min(1439, daylight[-1]+1)] if daylight else None
        return json.dumps(result)
    if action == 'validate':
        validate(request['scene'])
        return 'true'
    if action == 'seasons':
        return json.dumps(season_dates(int(request['year'])))
    if action == 'shape':
        p = request['parameters']
        if p['shape'] == 'bars':
            poly = make_bar_footprint(p['width'], p['depth'], p['vx'], p['vy'], p['dx'], p['dy'])
        elif p['shape'] == 'y' and p['mode'] == 'triangle':
            poly = make_triangle_y_footprint(p['arm'], p['thickness'])
        else:
            poly = make_footprint('I자형' if p['shape'] == 'i' else 'Y자형',
                                  p['width'], p['depth'], p['thickness'])
        return json.dumps(rotate_footprint(poly, p['rotation']))
    raise ValueError('알 수 없는 작업입니다.')
