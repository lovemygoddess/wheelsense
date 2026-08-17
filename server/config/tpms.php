<?php

return [
    // Set these only in a deployment environment. The public source keeps
    // wheel identifiers empty so examples and tests cannot target a device.
    'front_mac' => env('TPMS_FRONT_MAC', ''),
    'rear_mac' => env('TPMS_REAR_MAC', ''),
];
