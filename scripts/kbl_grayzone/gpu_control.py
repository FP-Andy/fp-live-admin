"""Explicit user-initiated power-on of the configured, existing T4 only."""
import threading
import gpu_bridge

LOCK=threading.Lock()

def _client_and_config():
    import boto3
    from botocore.config import Config
    c=gpu_bridge.config()
    if not c.get('instanceId') or not c.get('region'):raise RuntimeError('기존 T4 인스턴스 설정을 확인하세요.')
    return boto3.client('ec2',region_name=c['region'],config=Config(connect_timeout=5,read_timeout=10,retries={'max_attempts':1})),c

def _state(client,c):
    return client.describe_instances(InstanceIds=[c['instanceId']])['Reservations'][0]['Instances'][0]['State']['Name']

def status():
    try:
        client,c=_client_and_config();state=_state(client,c)
        return {'state':state,'autoStart':bool(c.get('autoStart',True))}
    except Exception as exc:
        raise RuntimeError('T4 상태를 확인하지 못했습니다. AWS 연결과 권한을 확인하세요.') from exc

def start():
    # Does not change autoStart, resume a job, or select/create an instance.
    with LOCK:
        try:
            client,c=_client_and_config();state=_state(client,c)
            if state=='stopped':
                client.start_instances(InstanceIds=[c['instanceId']]);state='pending'
            elif state not in ('pending','running'):
                raise ValueError('T4가 정지 중이거나 사용할 수 없는 상태입니다. 잠시 후 다시 확인하세요.')
            return {'state':state,'autoStart':bool(c.get('autoStart',True))}
        except ValueError:raise
        except Exception as exc:
            raise RuntimeError('T4를 켜지 못했습니다. AWS 연결과 시작 권한을 확인하세요.') from exc
