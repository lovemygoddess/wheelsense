<?php

/*
 * Public, checked-in fallback metadata for the Dashboard's Relay version
 * comparison. Deployments may override these fields with a sidecar JSON file
 * next to the APK; no credentials or device identifiers belong here.
 */
return [
    'latest' => [
        'version_name' => null,
        'version_code' => null,
        'release_notes' => null,
    ],
    'version_code_map' => [],
];
