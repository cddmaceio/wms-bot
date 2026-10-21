param([string]$Image = 'wms-bot:local-validation')
$ErrorActionPreference = 'Stop'

function Invoke-ValidationDocker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Falha no comando Docker de validacao (codigo $LASTEXITCODE)." }
}

# Somente recursos novos e exclusivos deste teste são criados ou removidos.
$validationName = 'wms-bot-validation-' + [guid]::NewGuid().ToString('N')
$validationVolume = $validationName + '-data'
$validationToken = 'validation-only-token-never-use-in-production'
$validationKey = 'a' * 64
$createdVolume = $false
$createdContainer = $false
try {
    Invoke-ValidationDocker volume create $validationVolume | Out-Null
    $createdVolume = $true
    Invoke-ValidationDocker run -d --name $validationName --network none --shm-size 1g --mount "type=volume,source=$validationVolume,target=/data" --env "ADMIN_TOKEN=$validationToken" --env "SETTINGS_KEY=$validationKey" $Image | Out-Null
    $createdContainer = $true
    $smokeFile = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../tests/container-smoke.cjs'))
    Invoke-ValidationDocker cp $smokeFile "${validationName}:/app/container-smoke.cjs"
    Invoke-ValidationDocker exec $validationName node container-smoke.cjs
    Invoke-ValidationDocker restart $validationName | Out-Null
    Invoke-ValidationDocker exec $validationName node container-smoke.cjs --after-restart
    Invoke-ValidationDocker exec $validationName node dist/backup.js /data/backup-validation.sqlite3
    Invoke-ValidationDocker stop --time 35 $validationName | Out-Null
    Invoke-ValidationDocker run --rm --network none --mount "type=volume,source=$validationVolume,target=/data" --env "SETTINGS_KEY=$validationKey" $Image node dist/restore-safe.js
    Write-Output 'Validacao Docker concluida, sem conexao externa e sem dados de producao.'
}
finally {
    if ($createdContainer) { & docker rm --force $validationName | Out-Null }
    if ($createdVolume) { & docker volume rm $validationVolume | Out-Null }
}
