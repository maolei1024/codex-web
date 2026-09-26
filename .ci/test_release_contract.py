#!/usr/bin/env python3
"""Offline fixture contract check for trusted project .ci/image_release.py files.

Imports supplied trusted local code. Registry requests and digest-record writes
are replaced with an in-memory fixture; no registry, CI or cluster is contacted.
"""
import argparse,concurrent.futures,hashlib,importlib.util,json,threading
from pathlib import Path
from unittest.mock import patch

def check(path):
    spec=importlib.util.spec_from_file_location('release_contract_target',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    data={};writes=[];lock=threading.Lock();repo='fixture/app'
    def raw(obj):return json.dumps(obj,separators=(',',':')).encode()
    def digest(value):return 'sha256:'+hashlib.sha256(value).hexdigest()
    def artifact(batch,arch):
        cfg=raw({'os':'linux','architecture':arch,'config':{'Labels':{'org.opencontainers.image.version':batch}}})
        data[repo+'/blobs/'+digest(cfg)]=cfg
        obj=raw({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'digest':digest(cfg),'size':len(cfg)},'layers':[]})
        data[repo+'/manifests/'+digest(obj)]=obj
        data[repo+'/manifests/'+batch+'-'+arch]=obj
        return digest(obj)
    expected={n:{artifact(n,a) for a in ('amd64','arm64')} for n in ('build-701','build-702')}
    def request(method,path,data_value=None,media=None,missing=False):
        with lock:
            if method=='GET':
                if path not in data:
                    if missing:return None,{}
                    raise RuntimeError('Missing fixture artifact '+path)
                return data[path],{}
            if method=='PUT':data[path]=data_value;writes.append(path);return b'',{}
            raise AssertionError('Unexpected method '+method)
    with patch.object(module,'request',side_effect=request),patch.object(module,'record'):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
            list(ex.map(lambda n:module.merge(repo,n,['amd64','arm64'],[]),expected))
        for n,children in expected.items():
            assert {c['digest'] for c in json.loads(data[repo+'/manifests/'+n])['manifests']}==children,'Cross-pipeline artifact mixing'
        count=len(writes);module.merge(repo,'build-701',['amd64','arm64'],[])
        assert len(writes)==count,'Same digest retry wrote again'
        original=data[repo+'/manifests/build-701']
        conflict=raw({'schemaVersion':2,'mediaType':module.INDEX,'manifests':[]})
        try:module.publish(repo,'build-701',conflict)
        except RuntimeError:pass
        else:raise AssertionError('Different digest overwrote immutable tag')
        assert data[repo+'/manifests/build-701']==original and len(writes)==count
        artifact('build-703','amd64')
        try:module.merge(repo,'build-703',['amd64','arm64'],['latest'])
        except RuntimeError:pass
        else:raise AssertionError('Missing ARM64 permitted final publication')
        assert repo+'/manifests/build-703' not in data and repo+'/manifests/latest' not in data
        assert len(writes)==count
    return {'helper':str(path),'checks':['two concurrent pipeline IDs isolated','same digest retry is read-only','different digest rejected','missing ARM64 blocks final and alias'],'result':'pass','scope':'Offline fixture; does not prove server-side atomic same-tag locking or live deploy gating'}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('helpers',nargs='+',type=Path)
    for path in p.parse_args().helpers:print(json.dumps(check(path),ensure_ascii=False))
