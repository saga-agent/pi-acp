import {
  zCloseSessionResponse,
  zAuthenticateResponse,
  zInitializeResponse,
  zListSessionsResponse,
  zLoadSessionResponse,
  zLogoutResponse,
  zNewSessionResponse,
  zPromptResponse,
  zRequestPermissionRequest,
  zResumeSessionResponse,
  zSessionNotification,
  zSetSessionConfigOptionResponse,
  zSetSessionModelResponse,
  zSetSessionModeResponse
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'

export const acpSchema = {
  authenticateResponse: zAuthenticateResponse,
  closeSessionResponse: zCloseSessionResponse,
  initializeResponse: zInitializeResponse,
  listSessionsResponse: zListSessionsResponse,
  loadSessionResponse: zLoadSessionResponse,
  logoutResponse: zLogoutResponse,
  newSessionResponse: zNewSessionResponse,
  promptResponse: zPromptResponse,
  requestPermissionRequest: zRequestPermissionRequest,
  resumeSessionResponse: zResumeSessionResponse,
  sessionNotification: zSessionNotification,
  setSessionConfigOptionResponse: zSetSessionConfigOptionResponse,
  setSessionModelResponse: zSetSessionModelResponse,
  setSessionModeResponse: zSetSessionModeResponse
}
