<?php
$f = "/var/www/html/piltistoreapp/kabijewellery_frontend/packages/Webkul/Admin/src/Resources/views/configuration/field-type.blade.php";
$c = file_get_contents($f);
$c = str_replace("{{ Storage::url(\$value) }}", "{{ \$value ? Storage::url(\$value) : '' }}", $c);
file_put_contents($f, $c);
