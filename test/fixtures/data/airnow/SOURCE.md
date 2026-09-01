# AirNow Hourly AQ Obs fixture provenance

These synthetic fixtures were reconstructed from the field names and sample layout in the
official AirNow `HourlyAQObs_yyyymmddhh.dat` format specification. Values and site names are
invented for tests; no live response or user data is stored here.

The fixture intentionally includes an in-bounds site, an out-of-bounds site, quoted CSV text,
and a negative concentration. AirNow documents these data as preliminary and notes that small
negative raw concentrations can occur.
