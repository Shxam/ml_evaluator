#include <node_api.h>

#if defined(_WIN32)
#include <io.h>
#include <sys/locking.h>
#include <windows.h>
#else
#include <sys/file.h>
#include <unistd.h>
#include <errno.h>
#endif

// flock(fd, op)
napi_value PosixFlock(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_status status = napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    if (status != napi_ok || argc < 2) {
        napi_throw_type_error(env, NULL, "Expected fd and op arguments");
        return NULL;
    }

    int32_t fd = 0;
    int32_t op = 0;
    napi_get_value_int32(env, args[0], &fd);
    napi_get_value_int32(env, args[1], &op);

#if defined(_WIN32)
    // On Windows, use _locking on the C runtime file descriptor
    // LK_NBLCK = 2 (non-blocking lock), LK_UNLCK = 0 (unlock)
    int res = 0;
    if (op & 8) { // LOCK_UN
        res = _locking(fd, _LK_UNLCK, 1);
    } else {
        res = _locking(fd, _LK_NBLCK, 1);
    }
    if (res != 0) {
        napi_throw_error(env, "EWOULDBLOCK", "Lock contention: descriptor already locked");
        return NULL;
    }
#else
    int res = flock(fd, op);
    if (res != 0) {
        int err = errno;
        if (err == EWOULDBLOCK || err == EAGAIN || err == EACCES) {
            napi_throw_error(env, "EWOULDBLOCK", "Lock contention: flock EWOULDBLOCK");
        } else {
            napi_throw_error(env, "EFAILED", "flock system call failed");
        }
        return NULL;
    }
#endif

    napi_value result;
    napi_get_boolean(env, 1, &result);
    return result;
}

napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;
    napi_status status = napi_create_function(env, "flock", NAPI_AUTO_LENGTH, PosixFlock, NULL, &fn);
    if (status != napi_ok) return NULL;
    status = napi_set_named_property(env, exports, "flock", fn);
    if (status != napi_ok) return NULL;
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
