/*
 * Copyright (C) 2026 David Byers dba Byers Brands
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

#import <LocalAuthentication/LocalAuthentication.h>
#import <Foundation/Foundation.h>
#include <stdlib.h>
#include <string.h>

void free_biometric_error_string(char* ptr) {
    if (ptr != NULL) {
        free(ptr);
    }
}

int verify_biometric_auth_macos(const char* reason_str, char** error_out, int* error_code_out) {
    @autoreleasepool {
        LAContext *context = [[LAContext alloc] init];
        NSError *error = nil;
        NSString *reason = (reason_str != NULL && strlen(reason_str) > 0)
            ? [NSString stringWithUTF8String:reason_str]
            : @"Authenticate with Touch ID";

        // Check if biometrics (Touch ID / Apple Watch) can be evaluated
        if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:&error]) {
            if (error_code_out != NULL) {
                *error_code_out = error != nil ? (int)error.code : (int)LAErrorBiometryNotAvailable;
            }
            if (error_out != NULL) {
                NSString *desc = error != nil ? [error localizedDescription] : @"Touch ID / Biometrics not available on this device";
                *error_out = strdup([desc UTF8String]);
            }
            return -1;
        }

        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block BOOL authSuccess = NO;
        __block NSString *authErrorMsg = nil;
        __block NSInteger authErrorCode = 0;

        [context evaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
                localizedReason:reason
                          reply:^(BOOL success, NSError * _Nullable evalError) {
            authSuccess = success;
            if (evalError != nil) {
                authErrorMsg = [evalError localizedDescription];
                authErrorCode = evalError.code;
            }
            dispatch_semaphore_signal(sem);
        }];

        dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

        if (authSuccess) {
            if (error_code_out != NULL) {
                *error_code_out = 0;
            }
            return 0;
        } else {
            if (error_code_out != NULL) {
                *error_code_out = (int)authErrorCode;
            }
            if (error_out != NULL) {
                NSString *desc = authErrorMsg != nil ? authErrorMsg : @"Biometric authentication failed";
                *error_out = strdup([desc UTF8String]);
            }
            return -1;
        }
    }
}
