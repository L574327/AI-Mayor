!macro customInstall
  DeleteRegKey HKCR "appaimayor"
  WriteRegStr HKCR "appaimayor" "" "URL:appaimayor"
  WriteRegStr HKCR "appaimayor" "URL Protocol" ""
  WriteRegStr HKCR "appaimayor\shell" "" ""
  WriteRegStr HKCR "appaimayor\shell\Open" "" ""
  WriteRegStr HKCR "appaimayor\shell\Open\command" "" "$INSTDIR\{APP_EXECUTABLE_FILENAME} %1"
!macroend

!macro customUnInstall
  DeleteRegKey HKCR "appaimayor"
!macroend

# Fix Can not find Squairrel error
# https://github.com/electron-userland/electron-builder/issues/837#issuecomment-355698368
!macro customInit
!macroend
