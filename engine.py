"""Local ENU metres; z is absolute elevation in a shared vertical datum."""
import calendar
import math
from datetime import datetime, timedelta

EPS = 1e-7


def solar_vector(moment, latitude, longitude, timezone=9):
    """NOAA fractional-year approximation; no refraction. East, north, up."""
    hour = moment.hour + moment.minute / 60 + moment.second / 3600
    gamma = 2 * math.pi / (366 if calendar.isleap(moment.year) else 365) * (
        moment.timetuple().tm_yday - 1 + (hour - 12) / 24)
    c, s = math.cos, math.sin
    eq = 229.18 * (.000075 + .001868*c(gamma) - .032077*s(gamma)
                   - .014615*c(2*gamma) - .040849*s(2*gamma))
    dec = (.006918 - .399912*c(gamma) + .070257*s(gamma)
           - .006758*c(2*gamma) + .000907*s(2*gamma)
           - .002697*c(3*gamma) + .00148*s(3*gamma))
    ha = math.radians((hour*60 + eq + 4*longitude - 60*timezone)/4 - 180)
    lat = math.radians(latitude)
    return (-c(dec)*s(ha), c(lat)*s(dec)-s(lat)*c(dec)*c(ha),
            s(lat)*s(dec)+c(lat)*c(dec)*c(ha))


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def sub(a, b):
    return tuple(x-y for x, y in zip(a, b))


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def triangle_hit(origin, direction, triangle):
    """Two-sided Moller-Trumbore ray intersection (distance or None)."""
    a, b, c = triangle
    e1, e2 = sub(b, a), sub(c, a)
    h = cross(direction, e2)
    det = dot(e1, h)
    if abs(det) < EPS:
        return None
    q = sub(origin, a)
    u = dot(q, h) / det
    if u < -EPS or u > 1+EPS:
        return None
    r = cross(q, e1)
    v = dot(direction, r) / det
    if v < -EPS or u+v > 1+EPS:
        return None
    t = dot(e2, r) / det
    return t if t > EPS else None


def inside(x, y, polygon):
    result = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if (a[1] > y) != (b[1] > y):
            if x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
                result = not result
    return result


def building_hit(origin, direction, building):
    """Extruded simple polygon, including roof and floor; supports concavity."""
    poly, base = building['footprint'], building['base_z']
    top = base + building['height']
    if base < origin[2] < top and inside(*origin[:2], poly):
        return EPS
    hits = []
    for a, b in zip(poly, poly[1:] + poly[:1]):
        p, q = (*a, base), (*b, base)
        r, s = (*b, top), (*a, top)
        for tri in ((p, q, r), (p, r, s)):
            t = triangle_hit(origin, direction, tri)
            if t is not None:
                hits.append(t)
    if abs(direction[2]) > EPS:
        for z in (base, top):
            t = (z-origin[2])/direction[2]
            if t > EPS and inside(origin[0]+t*direction[0], origin[1]+t*direction[1], poly):
                hits.append(t)
    return min(hits) if hits else None


def terrain_z(scene, x, y):
    heights = []
    for tri in scene['terrain']:
        a, b, c = tri
        den = (b[1]-c[1])*(a[0]-c[0]) + (c[0]-b[0])*(a[1]-c[1])
        if abs(den) < EPS:
            continue
        u = ((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den
        v = ((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den
        if u >= -EPS and v >= -EPS and u+v <= 1+EPS:
            heights.append(u*a[2]+v*b[2]+(1-u-v)*c[2])
    return max(heights) if heights else None


def obstruction(scene, origin, direction, buildings=True, terrain=True):
    hits = []
    if buildings:
        for building in scene['buildings']:
            t = building_hit(origin, direction, building)
            if t is not None:
                hits.append((t, 'building', building['name']))
    if terrain:
        for tri in scene['terrain']:
            t = triangle_hit(origin, direction, tri)
            if t is not None:
                hits.append((t, 'terrain', '지형'))
    return min(hits) if hits else None


def validate(scene):
    def finite(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError('좌표와 수치는 유한한 숫자여야 합니다.')
    for key, lo, hi in [('latitude', -90, 90), ('longitude', -180, 180), ('timezone', -12, 14)]:
        finite(scene[key])
        if not lo <= scene[key] <= hi:
            raise ValueError(f'{key} 범위: {lo} ~ {hi}')
    def point(p, size):
        if len(p) != size:
            raise ValueError(f'좌표는 {size}개 값이 필요합니다.')
        for v in p:
            finite(v)
    point(scene['observer'], 3)
    if scene.get('facing') is not None:
        finite(scene['facing'])
        if not 0 <= scene['facing'] < 360:
            raise ValueError('창 방향은 북=0, 동=90, 남=180, 서=270입니다.')
    for b in scene['buildings']:
        if not isinstance(b['name'], str) or not b['name'].strip():
            raise ValueError('건물 이름이 필요합니다.')
        finite(b['base_z'])
        finite(b['height'])
        if b['height'] <= 0 or len(b['footprint']) < 3:
            raise ValueError('건물 높이는 양수, 외곽선은 최소 3점이어야 합니다.')
        for p in b['footprint']:
            point(p, 2)
        poly = b['footprint']
        area = sum(a[0]*b[1]-a[1]*b[0] for a, b in zip(poly, poly[1:]+poly[:1]))
        if abs(area) < EPS:
            raise ValueError('건물 외곽선의 면적이 0입니다.')
    for tri in scene['terrain']:
        if len(tri) != 3:
            raise ValueError('지형은 삼각형의 목록이어야 합니다.')
        for p in tri:
            point(p, 3)
        if sum(v*v for v in cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))) < EPS:
            raise ValueError('면적이 0인 지형 삼각형입니다.')
    ground = terrain_z(scene, *scene['observer'][:2])
    if ground is not None and scene['observer'][2] <= ground + EPS:
        raise ValueError('관측점은 지표면보다 높아야 합니다. Z는 지면 위 높이가 아닌 표고입니다.')
    for b in scene['buildings']:
        if inside(*scene['observer'][:2], b['footprint']) and b['base_z'] <= scene['observer'][2] <= b['base_z']+b['height']:
            raise ValueError('관측점이 건물 내부입니다. 창문 바깥으로 약 0.1m 이동하세요.')


def simulate(scene, day, step=5, buildings=True, terrain=True):
    validate(scene)
    if not isinstance(step, int) or not 1 <= step <= 60:
        raise ValueError('계산 간격은 1~60분 정수입니다.')
    start = datetime.strptime(day, '%Y-%m-%d')
    facing = scene.get('facing')
    normal = None if facing is None else (math.sin(math.radians(facing)), math.cos(math.radians(facing)), 0)
    rows = []
    # Playback step is not numerical integration precision. Use the same
    # minute-start horizon samples as daylight_range for every playback speed.
    for minute in range(1440):
        duration = 1
        moment = start + timedelta(minutes=minute)
        direction = solar_vector(moment, scene['latitude'], scene['longitude'], scene['timezone'])
        baseline = direction[2] > 0
        window_sun = baseline and (normal is None or dot(direction, normal) > EPS)
        state, blocker = ('sun', '') if window_sun else ('night' if direction[2] <= 0 else 'back', '')
        if window_sun:
            hit = obstruction(scene, scene['observer'], direction, buildings, terrain)
            if hit:
                _, state, blocker = hit
        rows.append({'minute': minute, 'duration': duration, 'baseline': baseline,
                     'state': state, 'blocker': blocker,
                     'altitude': math.degrees(math.asin(max(-1, min(1, direction[2])))),
                     'azimuth': math.degrees(math.atan2(direction[0], direction[1])) % 360})
    total = sum(r['duration'] for r in rows if r['state'] == 'sun')
    baseline = sum(r['duration'] for r in rows if r['baseline'])
    longest = run = 0
    for row in rows:
        run = run + row['duration'] if row['state'] == 'sun' else 0
        longest = max(longest, run)
    return {'rows': rows, 'sun_minutes': total, 'baseline_minutes': baseline, 'longest_minutes': longest}


def daylight_range(day, latitude, longitude, timezone):
    """One-minute geometric sunrise/sunset, without atmospheric refraction."""
    start = datetime.strptime(day, '%Y-%m-%d')
    daylight = [m for m in range(1440) if solar_vector(
        start+timedelta(minutes=m), latitude, longitude, timezone)[2] > 0]
    return (daylight[0], min(1439, daylight[-1]+1)) if daylight else None


def shading_intervals(rows):
    """Contiguous primary-blocker intervals; boundaries follow sampled bins."""
    intervals = []
    for row in rows:
        if row['state'] not in ('building', 'terrain'):
            continue
        key = (row['state'], row['blocker'])
        start, end = row['minute'], row['minute'] + row['duration']
        if intervals and intervals[-1]['end'] == start and intervals[-1]['key'] == key:
            intervals[-1]['end'] = end
        else:
            intervals.append({'start': start, 'end': end, 'key': key})
    return intervals


def polygon_distance(first, second):
    """Shortest XY distance and endpoints, including overlap/containment."""
    if inside(*first[0], second):
        return 0.0, first[0], first[0]
    if inside(*second[0], first):
        return 0.0, second[0], second[0]
    best = (float('inf'), None, None)
    def project(p,a,b):
        dx,dy = b[0]-a[0],b[1]-a[1]
        den = dx*dx+dy*dy
        t = max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)) if den else 0
        return (a[0]+t*dx,a[1]+t*dy)
    for a,b in zip(first,first[1:]+first[:1]):
        for c,d in zip(second,second[1:]+second[:1]):
            rx,ry,sx,sy = b[0]-a[0],b[1]-a[1],d[0]-c[0],d[1]-c[1]
            den = rx*sy-ry*sx
            if abs(den)>EPS:
                t = ((c[0]-a[0])*sy-(c[1]-a[1])*sx)/den
                u = ((c[0]-a[0])*ry-(c[1]-a[1])*rx)/den
                if 0 <= t <= 1 and 0 <= u <= 1:
                    p = (a[0]+t*rx,a[1]+t*ry)
                    return 0.0,p,p
            for p,q in [(a,project(a,c,d)),(b,project(b,c,d)),(project(c,a,b),c),(project(d,a,b),d)]:
                distance = math.hypot(p[0]-q[0],p[1]-q[1])
                if distance < best[0]:
                    best = distance,p,q
    return best


def rotate_footprint(poly, degrees):
    """Clockwise rotation, centered for placement by bounding-box center."""
    if not math.isfinite(degrees):
        raise ValueError('회전각은 유한한 숫자를 입력하세요.')
    angle = math.radians(degrees % 360)
    c,s = math.cos(angle),math.sin(angle)
    cx = (min(p[0] for p in poly)+max(p[0] for p in poly))/2
    cy = (min(p[1] for p in poly)+max(p[1] for p in poly))/2
    rotated = [[(x-cx)*c+(y-cy)*s,-(x-cx)*s+(y-cy)*c] for x,y in poly]
    dx = (min(p[0] for p in rotated)+max(p[0] for p in rotated))/2
    dy = (min(p[1] for p in rotated)+max(p[1] for p in rotated))/2
    return [[x-dx,y-dy] for x,y in rotated]


def make_triangle_y_footprint(arm_length, thickness):
    """Equilateral triangle (side=thickness) plus three outward rectangles."""
    if any(not math.isfinite(v) or v <= 0 for v in (arm_length,thickness)):
        raise ValueError('직사각형 가로·세로는 0보다 큰 유한한 숫자여야 합니다.')
    radius = thickness/(2*math.sqrt(3))+arm_length
    poly = []
    for degrees in (30,150,270):
        angle = math.radians(degrees)
        dx,dy = math.cos(angle),math.sin(angle)
        poly.extend([[radius*dx+dy*thickness/2,radius*dy-dx*thickness/2],
                     [radius*dx-dy*thickness/2,radius*dy+dx*thickness/2]])
        corner = angle+math.pi/3
        poly.append([thickness/math.sqrt(3)*math.cos(corner),thickness/math.sqrt(3)*math.sin(corner)])
    cx = (min(p[0] for p in poly)+max(p[0] for p in poly))/2
    cy = (min(p[1] for p in poly)+max(p[1] for p in poly))/2
    return [[x-cx,y-cy] for x,y in poly]


def make_bar_footprint(horizontal_x, horizontal_y, vertical_x, vertical_y, offset_x=0, offset_y=0):
    """Union of overlapping bars; offsets locate the vertical bar's center."""
    if any(not math.isfinite(v) or v <= 0 for v in (horizontal_x,horizontal_y,vertical_x,vertical_y)):
        raise ValueError('두 바의 폭·길이는 0보다 큰 유한한 숫자여야 합니다.')
    if not all(math.isfinite(v) for v in (offset_x,offset_y)):
        raise ValueError('가지위치는 유한한 숫자를 입력하세요.')
    a = (-horizontal_x/2,-horizontal_y/2,horizontal_x/2,horizontal_y/2)
    b = (offset_x-vertical_x/2,offset_y-vertical_y/2,offset_x+vertical_x/2,offset_y+vertical_y/2)
    if min(a[2],b[2]) <= max(a[0],b[0]) or min(a[3],b[3]) <= max(a[1],b[1]):
        raise ValueError('두 바가 면적으로 겹치도록 가지위치를 조정하세요.')
    xs,ys = sorted(set((a[0],a[2],b[0],b[2]))),sorted(set((a[1],a[3],b[1],b[3])))
    edges = set()
    for x0,x1 in zip(xs,xs[1:]):
        for y0,y1 in zip(ys,ys[1:]):
            x,y = (x0+x1)/2,(y0+y1)/2
            if not any(r[0] < x < r[2] and r[1] < y < r[3] for r in (a,b)):
                continue
            corners = [(x0,y0),(x1,y0),(x1,y1),(x0,y1)]
            for p,q in zip(corners,corners[1:]+corners[:1]):
                if (q,p) in edges:
                    edges.remove((q,p))
                else:
                    edges.add((p,q))
    following = dict(edges)
    start = min(following)
    outline,p = [],start
    while True:
        outline.append(p)
        p = following[p]
        if p == start:
            break
    poly = [p for i,p in enumerate(outline)
            if (p[0]-outline[i-1][0])*(outline[(i+1)%len(outline)][1]-p[1]) !=
               (p[1]-outline[i-1][1])*(outline[(i+1)%len(outline)][0]-p[0])]
    cx,cy = (min(xs)+max(xs))/2,(min(ys)+max(ys))/2
    return [[x-cx,y-cy] for x,y in poly]


def make_footprint(shape, width, depth, arm_thickness=12):
    """Centered bounding box; all lengths and perpendicular arm widths in metres."""
    if any(not math.isfinite(v) or v <= 0 for v in (width, depth)):
        raise ValueError('폭·길이는 0보다 큰 유한한 숫자여야 합니다.')
    if shape in ('I자형', '-자형'):
        return [[-width/2,-depth/2],[width/2,-depth/2],[width/2,depth/2],[-width/2,depth/2]]
    t = arm_thickness
    if not math.isfinite(t) or not 0 < t < min(width, depth):
        raise ValueError('가지 두께는 0보다 크고 전체 폭·길이보다 작아야 합니다.')
    if shape == 'L자형':
        poly = [[0,0],[width,0],[width,t],[t,t],[t,depth],[0,depth]]
    elif shape == '+자형':
        left,right = (width-t)/2,(width+t)/2
        bottom,top = (depth-t)/2,(depth+t)/2
        poly = [[left,0],[right,0],[right,bottom],[width,bottom],
                [width,top],[right,top],[right,depth],[left,depth],
                [left,top],[0,top],[0,bottom],[left,bottom]]
    elif shape == 'T자형':
        left,right = (width-t)/2,(width+t)/2
        poly = [[left,0],[right,0],[right,depth-t],[width,depth-t],
                [width,depth],[0,depth],[0,depth-t],[left,depth-t]]
    elif shape == 'Y자형':
        # Three 120-degree arms, with equal perpendicular thickness.
        half = t/2
        upper = (width-half)/(2*math.cos(math.pi/6))
        lower = depth-(upper/2+half*math.cos(math.pi/6))
        if min(upper,lower) <= half/math.sqrt(3):
            raise ValueError('Y자 가지가 너무 두껍습니다. 두께를 줄이거나 전체 크기를 늘리세요.')
        poly = []
        for degrees,length in [(30,upper),(150,upper),(270,lower)]:
            angle = math.radians(degrees)
            dx,dy = math.cos(angle),math.sin(angle)
            poly.extend([[length*dx+dy*half,length*dy-dx*half],
                         [length*dx-dy*half,length*dy+dx*half]])
            middle = angle+math.pi/3
            radius = half/math.sin(math.pi/3)
            poly.append([radius*math.cos(middle),radius*math.sin(middle)])
    else:
        raise ValueError('지원하지 않는 건물 형태입니다.')
    xs,ys = zip(*poly)
    return [[x-(min(xs)+max(xs))/2,y-(min(ys)+max(ys))/2] for x,y in poly]


def demo_scene():
    # Synthetic ridge south of observer, deliberately not real Seoul geography.
    terrain = []
    xs, ys = [-600, -300, 0, 300, 600], [-600, -300, 0, 300, 600]
    def p(x, y):
        return [x, y, 110 if y == -600 else 0]
    for x0, x1 in zip(xs, xs[1:]):
        for y0, y1 in zip(ys, ys[1:]):
            a,b,c,d = p(x0,y0),p(x1,y0),p(x1,y1),p(x0,y1)
            terrain.extend([[a,b,c], [a,c,d]])
    return {'name': '가상 예제 · 서울 위도 / 실제 지형 아님', 'latitude': 37.5665,
            'longitude': 126.978, 'timezone': 9, 'observer': [0, -6.1, 10], 'facing': 180,
            'buildings': [
                {'name':'남쪽 아파트', 'footprint':[[-20,-63.5],[20,-63.5],[20,-51.5],[-20,-51.5]], 'base_z':0, 'height':35},
                {'name':'동쪽 건물', 'footprint':[[60.25,-30],[72.25,-30],[72.25,10],[60.25,10]], 'base_z':0, 'height':24},
                {'name':'서쪽 건물', 'footprint':[[-63.5,-27.5],[-51.5,-27.5],[-51.5,12.5],[-63.5,12.5]], 'base_z':0, 'height':24},
                {'name':'남동쪽 건물', 'footprint':[[60.25,-87],[72.25,-87],[72.25,-47],[60.25,-47]], 'base_z':0, 'height':24},
                {'name':'관측 대상 건물', 'footprint':[[-20,-6],[20,-6],[20,6],[-20,6]], 'base_z':0, 'height':45}],
            'terrain': terrain}
