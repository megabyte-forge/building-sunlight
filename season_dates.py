"""Equinox/solstice dates in fixed Korean standard time (UTC+9).

Meeus chapter 27, periodic correction:
https://www.mat.uc.pt/~efemast/help/en/sol_equi.htm
TT to UT approximation:
https://eclipse.gsfc.nasa.gov/SEcat5/deltatpoly.html
Dates are astronomical approximations, not an official calendar service.
"""
import math
from datetime import datetime, timedelta
from functools import lru_cache


def delta_t(y):
    if y < 1920:
        t = y-1900
        return -2.79+1.494119*t-.0598939*t**2+.0061966*t**3-.000197*t**4
    if y < 1941:
        t = y-1920
        return 21.20+.84493*t-.076100*t**2+.0020936*t**3
    if y < 1961:
        t = y-1950
        return 29.07+.407*t-t*t/233+t**3/2547
    if y < 1986:
        t = y-1975
        return 45.45+1.067*t-t*t/260-t**3/718
    if y < 2005:
        t = y-2000
        return 63.86+.3345*t-.060374*t**2+.0017275*t**3+.000651814*t**4+.00002373599*t**5
    if y < 2050:
        t = y-2000
        return 62.92+.32217*t+.005589*t*t
    return -20+32*((y-1820)/100)**2-(.5628*(2150-y) if y < 2150 else 0)


@lru_cache(maxsize=128)
def season_dates(year):
    """Return spring, summer, autumn, winter ISO dates; supported 1900–3000."""
    if not 1900 <= year <= 3000:
        raise ValueError('계절 날짜 자동계산은 1900~3000년을 지원합니다.')
    coefficients = (
        (2451623.80984,365242.37404,.05169,-.00411,-.00057),
        (2451716.56767,365241.62603,.00325,.00888,-.00030),
        (2451810.21715,365242.01767,-.11575,.00337,.00078),
        (2451900.05952,365242.74049,-.06223,-.00823,.00032))
    terms = (
        (485,324.96,1934.136),(203,337.23,32964.467),(199,342.08,20.186),
        (182,27.85,445267.112),(156,73.14,45036.886),(136,171.52,22518.443),
        (77,222.54,65928.934),(74,296.72,3034.906),(70,243.58,9037.513),
        (58,119.81,33718.147),(52,297.17,150.678),(50,21.02,2281.226),
        (45,247.54,29929.562),(44,325.15,31555.956),(29,60.93,443.417),
        (18,155.12,67555.328),(17,288.79,4562.452),(16,198.04,62894.029),
        (14,199.76,31436.921),(12,95.39,14577.848),(12,287.11,31931.756),
        (12,320.81,34777.259),(9,227.73,1222.114),(8,15.45,16859.074))
    y = (year-2000)/1000
    dates = []
    for index, coeff in enumerate(coefficients):
        jde = sum(c*y**i for i,c in enumerate(coeff))
        t = (jde-2451545)/36525
        w = math.radians(35999.373*t-2.47)
        correction = sum(a*math.cos(math.radians(b+c*t)) for a,b,c in terms)
        jde += .00001*correction/(1+.0334*math.cos(w)+.0007*math.cos(2*w))
        moment = datetime(2000,1,1,12)+timedelta(days=jde-2451545,
            seconds=9*3600-delta_t(year+(3*(index+1)-.5)/12))
        dates.append(moment.strftime('%Y-%m-%d'))
    return tuple(dates)
